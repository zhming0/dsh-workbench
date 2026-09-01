// Package tunnel dials the dsh host and serves the runner's HTTP/2 RPC
// handler over that runner-initiated connection. RPCs keep flowing
// host → runner; only the transport direction is inverted, so runners work
// from networks without inbound reachability.
package tunnel

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"time"

	"golang.org/x/net/http2"
)

// Config describes one runner's registration with its host.
type Config struct {
	// HostURL names the host tunnel endpoint: tcp://host:port or
	// tls://host:port.
	HostURL   string
	SandboxID string
	Token     string
	// Handler serves the runner's RPC surface over each tunnel.
	Handler http.Handler
	Logf    func(format string, v ...any)
}

type hello struct {
	SandboxID string `json:"sandboxId"`
	Token     string `json:"token"`
}

type helloReply struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

const (
	handshakeTimeout = 10 * time.Second
	replyLimit       = 4096
	backoffFloor     = 500 * time.Millisecond
	backoffCeiling   = 10 * time.Second
)

// Run keeps one tunnel to the host alive until ctx ends, redialing with
// capped exponential backoff. Only an invalid configuration returns an error.
func Run(ctx context.Context, config Config) error {
	dial, err := dialerFor(config.HostURL)
	if err != nil {
		return err
	}
	logf := config.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	backoff := backoffFloor
	for {
		registered, err := serveOnce(ctx, dial, config)
		if ctx.Err() != nil {
			return nil
		}
		if err != nil {
			logf("tunnel: %v", err)
		}
		if registered {
			backoff = backoffFloor
		} else if backoff = backoff * 2; backoff > backoffCeiling {
			backoff = backoffCeiling
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(backoff):
		}
	}
}

// serveOnce performs one dial, handshake, and HTTP/2 serving pass.
// registered reports whether the host accepted the handshake, which resets
// the redial backoff.
func serveOnce(ctx context.Context, dial dialer, config Config) (registered bool, err error) {
	conn, err := dial(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()

	deadline := time.Now().Add(handshakeTimeout)
	if err := conn.SetDeadline(deadline); err != nil {
		return false, err
	}
	request, err := json.Marshal(hello{SandboxID: config.SandboxID, Token: config.Token})
	if err != nil {
		return false, err
	}
	if _, err := conn.Write(append(request, '\n')); err != nil {
		return false, fmt.Errorf("send handshake: %w", err)
	}
	reader := bufio.NewReaderSize(conn, replyLimit)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		return false, fmt.Errorf("read handshake reply: %w", err)
	}
	var reply helloReply
	if err := json.Unmarshal(line, &reply); err != nil {
		return false, fmt.Errorf("parse handshake reply: %w", err)
	}
	if !reply.OK {
		return false, fmt.Errorf("host rejected registration: %s", reply.Error)
	}
	if err := conn.SetDeadline(time.Time{}); err != nil {
		return false, err
	}

	// Close the connection when ctx ends so ServeConn returns promptly.
	done := make(chan struct{})
	defer close(done)
	go func() {
		select {
		case <-ctx.Done():
			conn.Close()
		case <-done:
		}
	}()

	server := &http2.Server{
		// The host pings every 30 seconds. Read-idle beyond that means the
		// host or the path is gone; drop the tunnel and redial.
		ReadIdleTimeout: 60 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	server.ServeConn(
		// The handshake reader may have buffered bytes of the host's HTTP/2
		// client preface; hand them to the server ahead of the socket.
		bufferedConn{Conn: conn, reader: reader},
		&http2.ServeConnOpts{Context: ctx, Handler: config.Handler},
	)
	return true, errors.New("tunnel closed")
}

type dialer func(ctx context.Context) (net.Conn, error)

func dialerFor(hostURL string) (dialer, error) {
	parsed, err := url.Parse(hostURL)
	if err != nil {
		return nil, fmt.Errorf("invalid HOST_URL: %w", err)
	}
	if parsed.Scheme != "tcp" && parsed.Scheme != "tls" {
		return nil, fmt.Errorf("HOST_URL scheme %q is not tcp or tls", parsed.Scheme)
	}
	if parsed.Host == "" || parsed.Port() == "" {
		return nil, fmt.Errorf("HOST_URL %q must name a host and port", hostURL)
	}
	address := parsed.Host
	if parsed.Scheme == "tls" {
		serverName := parsed.Hostname()
		return func(ctx context.Context) (net.Conn, error) {
			d := tls.Dialer{Config: &tls.Config{ServerName: serverName}}
			return d.DialContext(ctx, "tcp", address)
		}, nil
	}
	return func(ctx context.Context) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", address)
	}, nil
}

type bufferedConn struct {
	net.Conn
	reader *bufio.Reader
}

func (c bufferedConn) Read(p []byte) (int, error) { return c.reader.Read(p) }
