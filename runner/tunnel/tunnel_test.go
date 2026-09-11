package tunnel

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/net/http2"
)

// fakeHost accepts runner WebSockets the way the dsh host does: bearer token
// and sandbox header on the upgrade request, then HTTP/2 over the socket.
type fakeHost struct {
	server *httptest.Server
	token  string
	// accepted delivers each admitted connection with the sandbox it named.
	accepted chan acceptedRunner
	// refused counts handshakes turned away with 401.
	refused chan struct{}
}

type acceptedRunner struct {
	conn      net.Conn
	sandboxID string
}

func newFakeHost(t *testing.T, token string) *fakeHost {
	t.Helper()
	host := &fakeHost{token: token, accepted: make(chan acceptedRunner, 4), refused: make(chan struct{}, 4)}
	host.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/tunnel" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+host.token {
			http.Error(w, "invalid registration token", http.StatusUnauthorized)
			host.refused <- struct{}{}
			return
		}
		ws, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept: %v", err)
			return
		}
		// The request context ends with this handler; the tunnel outlives it.
		conn := websocket.NetConn(context.Background(), ws, websocket.MessageBinary)
		host.accepted <- acceptedRunner{conn: conn, sandboxID: r.Header.Get(SandboxIDHeader)}
	}))
	t.Cleanup(host.server.Close)
	return host
}

func (h *fakeHost) url() string {
	return "ws" + strings.TrimPrefix(h.server.URL, "http") + "/tunnel"
}

func (h *fakeHost) next(t *testing.T) acceptedRunner {
	t.Helper()
	select {
	case runner := <-h.accepted:
		return runner
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not register")
		return acceptedRunner{}
	}
}

func startRunner(t *testing.T, host *fakeHost, token string, handler http.Handler) (cancel func(), done <-chan struct{}) {
	t.Helper()
	ctx, cancelCtx := context.WithCancel(context.Background())
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_ = Run(ctx, Config{
			HostURL:   host.url(),
			SandboxID: "sandbox-one",
			Token:     token,
			Handler:   handler,
		})
	}()
	t.Cleanup(cancelCtx)
	return cancelCtx, finished
}

func TestServesRPCsOverRunnerInitiatedConnection(t *testing.T) {
	host := newFakeHost(t, "token-one")
	cancel, runnerDone := startRunner(t, host, "token-one", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "hello "+r.URL.Path)
	}))

	runner := host.next(t)
	if runner.sandboxID != "sandbox-one" {
		t.Fatalf("unexpected sandbox header %q", runner.sandboxID)
	}

	// The host side speaks plain HTTP/2 over the accepted WebSocket.
	client := &http.Client{Transport: &http2.Transport{
		AllowHTTP: true,
		DialTLSContext: func(context.Context, string, string, *tls.Config) (net.Conn, error) {
			return runner.conn, nil
		},
	}}
	response, err := client.Get("http://runner.invalid/health")
	if err != nil {
		t.Fatalf("request over tunnel: %v", err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
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
	host := newFakeHost(t, "token-one")
	startRunner(t, host, "wrong", http.NewServeMux())

	// A rejected runner must come back on its own.
	for range 2 {
		select {
		case <-host.refused:
		case <-time.After(5 * time.Second):
			t.Fatal("runner did not redial after rejection")
		}
	}
}

func TestAcceptedRegistrationRedialsAfterClose(t *testing.T) {
	host := newFakeHost(t, "token-one")
	startRunner(t, host, "token-one", http.NewServeMux())

	_ = host.next(t).conn.Close()
	_ = host.next(t).conn.Close()
}

func TestRejectionReportsHostReason(t *testing.T) {
	host := newFakeHost(t, "token-one")
	_, err := serveOnce(context.Background(), Config{
		HostURL:   host.url(),
		SandboxID: "sandbox-one",
		Token:     "wrong",
		Handler:   http.NewServeMux(),
	})
	if err == nil || !strings.Contains(err.Error(), "401 Unauthorized: invalid registration token") {
		t.Fatalf("error %v should carry the host's status and reason", err)
	}
}

func TestValidateHostURL(t *testing.T) {
	for _, invalid := range []string{"", "host:8081", "tcp://host:8081", "tls://host:8081", "http://host/tunnel", "ws:///tunnel"} {
		if err := validateHostURL(invalid); err == nil {
			t.Errorf("validateHostURL(%q) succeeded, want error", invalid)
		}
	}
	for _, valid := range []string{"ws://host:8081/tunnel", "wss://dsh.example.com/tunnel"} {
		if err := validateHostURL(valid); err != nil {
			t.Errorf("validateHostURL(%q): %v", valid, err)
		}
	}
	if err := validateHostURL("tcp://host:8081"); !strings.Contains(err.Error(), "not ws or wss") {
		t.Error("scheme error should name the accepted schemes")
	}
}
