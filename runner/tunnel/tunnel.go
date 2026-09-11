// Package tunnel dials the dsh host and serves the runner's HTTP/2 RPC
// handler over that runner-initiated connection. RPCs keep flowing
// host → runner; only the transport direction is inverted, so runners work
// from networks without inbound reachability.
//
// The connection is a WebSocket. That lets the host's tunnel share an HTTPS
// proxy or Ingress with its Web UI, so wss:// gets TLS from the operator's
// existing certificate while runners inside the trust domain dial ws://.
package tunnel

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/net/http2"
)

// Config describes one runner's registration with its host.
type Config struct {
	// HostURL names the host tunnel endpoint: ws://host:port/tunnel or
	// wss://host/tunnel.
	HostURL   string
	SandboxID string
	Token     string
	// Handler serves the runner's RPC surface over each tunnel.
	Handler http.Handler
	Logf    func(format string, v ...any)
}

// SandboxIDHeader carries the runner's sandbox ID on the upgrade request; the
// registration token travels as a bearer token.
const SandboxIDHeader = "X-Dsh-Sandbox-Id"

const (
	dialTimeout    = 10 * time.Second
	backoffFloor   = 500 * time.Millisecond
	backoffCeiling = 10 * time.Second
)

// Run keeps one tunnel to the host alive until ctx ends, redialing with
// capped exponential backoff. Only an invalid configuration returns an error.
func Run(ctx context.Context, config Config) error {
	if err := validateHostURL(config.HostURL); err != nil {
		return err
	}
	logf := config.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}
	backoff := backoffFloor
	for {
		registered, err := serveOnce(ctx, config)
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

// serveOnce performs one WebSocket handshake and HTTP/2 serving pass.
// registered reports whether the host accepted the handshake, which resets
// the redial backoff.
func serveOnce(ctx context.Context, config Config) (registered bool, err error) {
	header := http.Header{}
	header.Set("Authorization", "Bearer "+config.Token)
	header.Set(SandboxIDHeader, config.SandboxID)
	// The deadline bounds only the handshake; the accepted connection lives
	// until ctx ends or the host closes it.
	dialCtx, cancelDial := context.WithTimeout(ctx, dialTimeout)
	ws, response, err := websocket.Dial(dialCtx, config.HostURL, &websocket.DialOptions{HTTPHeader: header})
	cancelDial()
	if err != nil {
		if response != nil && response.StatusCode != http.StatusSwitchingProtocols {
			return false, fmt.Errorf("host rejected registration: %s", rejection(response))
		}
		return false, fmt.Errorf("dial host: %w", err)
	}
	// A message is whatever chunk the host's HTTP/2 session handed its
	// socket, so its size is not a protocol property to bound here; the
	// default 32 KiB limit would cut the tunnel if that chunking ever grew.
	// NetConn streams messages, and HTTP/2 framing already limits reads.
	ws.SetReadLimit(-1)
	conn := websocket.NetConn(ctx, ws, websocket.MessageBinary)
	defer func() { _ = conn.Close() }()

	server := &http2.Server{
		// The host pings every 30 seconds. Read-idle beyond that means the
		// host or the path is gone; drop the tunnel and redial.
		ReadIdleTimeout: 60 * time.Second,
		PingTimeout:     15 * time.Second,
	}
	server.ServeConn(conn, &http2.ServeConnOpts{Context: ctx, Handler: config.Handler})
	return true, errors.New("tunnel closed")
}

// rejection renders the host's HTTP refusal, which carries a short reason in
// its body, as one log line.
func rejection(response *http.Response) string {
	reason := response.Status
	if response.Body != nil {
		body, _ := io.ReadAll(response.Body)
		if text := strings.TrimSpace(string(body)); text != "" {
			reason += ": " + text
		}
	}
	return reason
}

func validateHostURL(hostURL string) error {
	parsed, err := url.Parse(hostURL)
	if err != nil {
		return fmt.Errorf("invalid HOST_URL: %w", err)
	}
	if parsed.Scheme != "ws" && parsed.Scheme != "wss" {
		return fmt.Errorf("HOST_URL scheme %q is not ws or wss", parsed.Scheme)
	}
	if parsed.Hostname() == "" {
		return fmt.Errorf("HOST_URL %q must name a host", hostURL)
	}
	return nil
}
