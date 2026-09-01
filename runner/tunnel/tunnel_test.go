package tunnel

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"golang.org/x/net/http2"
)

// acceptOne reads a handshake from the next connection, answers it, and when
// accepted returns the connection with any read-ahead preserved.
func acceptOne(t *testing.T, listener net.Listener, accept bool) (net.Conn, hello) {
	t.Helper()
	conn, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}
	reader := bufio.NewReader(conn)
	line, err := reader.ReadBytes('\n')
	if err != nil {
		t.Fatalf("read handshake: %v", err)
	}
	var request hello
	if err := json.Unmarshal(line, &request); err != nil {
		t.Fatalf("parse handshake: %v", err)
	}
	reply, _ := json.Marshal(helloReply{OK: accept, Error: "not accepted"})
	if _, err := conn.Write(append(reply, '\n')); err != nil {
		t.Fatalf("write reply: %v", err)
	}
	if !accept {
		conn.Close()
	}
	return bufferedConn{Conn: conn, reader: reader}, request
}

func TestServesRPCsOverRunnerInitiatedConnection(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runnerDone := make(chan struct{})
	go func() {
		defer close(runnerDone)
		_ = Run(ctx, Config{
			HostURL:   "tcp://" + listener.Addr().String(),
			SandboxID: "sandbox-one",
			Token:     "token-one",
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				io.WriteString(w, "hello "+r.URL.Path)
			}),
		})
	}()

	conn, request := acceptOne(t, listener, true)
	if request.SandboxID != "sandbox-one" || request.Token != "token-one" {
		t.Fatalf("unexpected handshake: %+v", request)
	}

	// The host side speaks plain HTTP/2 over the accepted connection.
	client := &http.Client{Transport: &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(context.Context, string, string, *tls.Config) (net.Conn, error) {
			return conn, nil
		},
	}}
	response, err := client.Get("http://runner.invalid/health")
	if err != nil {
		t.Fatalf("request over tunnel: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	response.Body.Close()
	if string(body) != "hello /health" {
		t.Fatalf("unexpected body %q", body)
	}

	cancel()
	select {
	case <-runnerDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop after cancel")
	}
}

func TestRejectedRegistrationRedials(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go Run(ctx, Config{
		HostURL:   "tcp://" + listener.Addr().String(),
		SandboxID: "sandbox-one",
		Token:     "wrong",
		Handler:   http.NewServeMux(),
	})

	// A rejected runner must come back on its own.
	acceptOne(t, listener, false)
	acceptOne(t, listener, false)
}

func TestDialerForRejectsInvalidURLs(t *testing.T) {
	for _, invalid := range []string{"", "host:8081", "http://host:8081", "tcp://host"} {
		if _, err := dialerFor(invalid); err == nil {
			t.Errorf("dialerFor(%q) succeeded, want error", invalid)
		}
	}
	for _, valid := range []string{"tcp://host:8081", "tls://host:443"} {
		if _, err := dialerFor(valid); err != nil {
			t.Errorf("dialerFor(%q): %v", valid, err)
		}
	}
	if !strings.Contains(func() string {
		_, err := dialerFor("unix:///run/dsh.sock")
		return err.Error()
	}(), "not tcp or tls") {
		t.Error("scheme error should name the accepted schemes")
	}
}
