package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"connectrpc.com/connect"
	"github.com/zhming0/dsh-sandbox/runner/auth"
	"github.com/zhming0/dsh-sandbox/runner/credentials"
	"github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1/sandboxv1connect"
	"github.com/zhming0/dsh-sandbox/runner/service"
	"github.com/zhming0/dsh-sandbox/runner/telemetry"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"
)

func getenv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func main() {
	socket := getenv("CREDENTIAL_SOCKET", "/run/dsh/credentials.sock")
	if len(os.Args) > 1 && os.Args[1] == "git-credential" {
		action := ""
		if len(os.Args) > 2 {
			action = os.Args[2]
		}
		if err := credentials.Helper(socket, action, os.Stdin, os.Stdout); err != nil {
			log.Fatal(err)
		}
		return
	}
	if err := serve(socket); err != nil {
		log.Fatal(err)
	}
}
func serve(socket string) error {
	sandboxID := os.Getenv("SANDBOX_ID")
	if sandboxID == "" {
		return errors.New("SANDBOX_ID is required")
	}
	pemBytes := []byte(os.Getenv("PROVIDER_PUBLIC_KEY"))
	if keyFile := os.Getenv("PROVIDER_PUBLIC_KEY_FILE"); len(pemBytes) == 0 && keyFile != "" {
		var err error
		pemBytes, err = os.ReadFile(keyFile)
		if err != nil {
			return err
		}
	}
	key, err := auth.ParsePublicKey(pemBytes)
	if err != nil {
		return err
	}
	stopTelemetry, err := telemetry.Start(context.Background())
	if err != nil {
		return err
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := stopTelemetry(ctx); err != nil {
			log.Printf("stopping telemetry: %v", err)
		}
	}()
	runnerService := service.New(sandboxID)
	listener, err := credentials.Serve(socket, runnerService)
	if err != nil {
		return err
	}
	defer listener.Close()
	interceptor := auth.Interceptor{Key: key, SandboxID: sandboxID}
	path, handler := sandboxv1connect.NewRunnerServiceHandler(runnerService, connect.WithInterceptors(interceptor))
	mux := http.NewServeMux()
	mux.Handle(path, handler)
	mux.HandleFunc("GET /health", func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("content-type", "text/plain; charset=utf-8")
		_, _ = response.Write([]byte("ok\n"))
	})
	instrumented := otelhttp.NewHandler(mux, "dsh-runner")
	server := &http.Server{Addr: getenv("ADDR", ":8080"), Handler: h2c.NewHandler(instrumented, &http2.Server{}), ReadHeaderTimeout: 10 * time.Second}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdown)
	}()
	log.Printf("dsh-runner listening on %s", server.Addr)
	err = server.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
