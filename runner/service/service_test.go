package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
	"github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1/sandboxv1connect"
)

func TestExecEmptyStdinMeansIgnore(t *testing.T) {
	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(sandboxv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	defer server.Close()
	client := sandboxv1connect.NewRunnerServiceClient(server.Client(), server.URL)

	exitCode := func(stdin []byte) int {
		stream, err := client.Exec(context.Background(), connect.NewRequest(&v1.ExecRequest{
			Argv:  []string{"/bin/bash", "-c", "test -p /dev/stdin"},
			Cwd:   t.TempDir(),
			Stdin: stdin,
		}))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = stream.Close() }()
		for stream.Receive() {
			if exited := stream.Msg().GetExited(); exited != nil {
				return int(exited.GetExitCode())
			}
		}
		t.Fatal("exec stream ended without an exit status")
		return -1
	}

	// Delivered bytes arrive over a pipe.
	if code := exitCode([]byte("data")); code != 0 {
		t.Fatalf("non-empty stdin: child saw a non-pipe stdin, exit = %d", code)
	}
	// Empty stdin is ignore: the child reads the null device, not an empty
	// pipe, so workdir-fallback tools like ripgrep behave.
	if code := exitCode(nil); code != 1 {
		t.Fatalf("empty stdin: child saw a pipe stdin, exit = %d", code)
	}
}

func TestWriteGuardsAndEditAmbiguity(t *testing.T) {
	s := New("box")
	p := filepath.Join(t.TempDir(), "file")
	w, err := s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("one one"), Guard: &v1.WriteFileRequest_CreateIfAbsent{CreateIfAbsent: true}}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("bad"), Guard: &v1.WriteFileRequest_CreateIfAbsent{CreateIfAbsent: true}}))
	if connect.CodeOf(err) != connect.CodeAlreadyExists {
		t.Fatalf("code = %v", connect.CodeOf(err))
	}
	_, err = s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "one", NewString: "two", ExpectedVersion: w.Msg.Version}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("ambiguous code = %v", connect.CodeOf(err))
	}
	_, err = s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "", NewString: "two"}))
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("empty edit code = %v", connect.CodeOf(err))
	}
	e, err := s.EditFile(context.Background(), connect.NewRequest(&v1.EditFileRequest{Path: p, OldString: "one", NewString: "two", ReplaceAll: true, ExpectedVersion: w.Msg.Version}))
	if err != nil {
		t.Fatal(err)
	}
	if string(e.Msg.After) != "two two" {
		t.Fatalf("after = %q", e.Msg.After)
	}
	_, err = s.WriteFile(context.Background(), connect.NewRequest(&v1.WriteFileRequest{Path: p, Content: []byte("bad"), Guard: &v1.WriteFileRequest_ExpectedVersion{ExpectedVersion: w.Msg.Version}}))
	if connect.CodeOf(err) != connect.CodeFailedPrecondition {
		t.Fatalf("stale code = %v", connect.CodeOf(err))
	}
}

func TestSecretsReplaceAndSafeEnvironment(t *testing.T) {
	t.Setenv("PROVIDER_PRIVATE_TOKEN", "must-not-leak")
	s := New("box")
	_, _ = s.SetSecrets(context.Background(), connect.NewRequest(&v1.SetSecretsRequest{Secrets: map[string]string{"FIRST": "1"}}))
	_, _ = s.SetSecrets(context.Background(), connect.NewRequest(&v1.SetSecretsRequest{Secrets: map[string]string{"SECOND": "2"}}))
	env := s.environment(map[string]string{"SECOND": "override"})
	if envValue(env, "FIRST") != "" || envValue(env, "SECOND") != "override" || envValue(env, "PROVIDER_PRIVATE_TOKEN") != "" {
		t.Fatalf("unsafe environment: %v", env)
	}
}

func TestResolveMissingLeafThroughSymlink(t *testing.T) {
	d := t.TempDir()
	real := filepath.Join(d, "real")
	_ = os.Mkdir(real, 0755)
	link := filepath.Join(d, "link")
	_ = os.Symlink(real, link)
	display, canonical, err := resolve(filepath.Join(link, "missing"), "")
	if err != nil {
		t.Fatal(err)
	}
	if display != filepath.Join(link, "missing") || canonical != filepath.Join(real, "missing") {
		t.Fatalf("got %q %q", display, canonical)
	}
}

func TestSetupRestoresGitCredentialHelperAfterWake(t *testing.T) {
	home := t.TempDir()
	workspace := t.TempDir()
	t.Setenv("HOME", home)
	if err := os.Mkdir(filepath.Join(workspace, ".git"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(workspace, ".dsh-setup-done"), []byte("complete\n"), 0644); err != nil {
		t.Fatal(err)
	}

	s := New("box")
	response, err := s.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{Workspace: workspace}))
	if err != nil {
		t.Fatal(err)
	}
	if response.Msg.Ran {
		t.Fatal("setup ran again despite its durable marker")
	}
	config, err := os.ReadFile(filepath.Join(home, ".gitconfig"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(config), "dsh-runner git-credential") {
		t.Fatalf("credential helper was not restored: %s", config)
	}
}

func TestSetupClonesBelowFilesystemRoot(t *testing.T) {
	home := t.TempDir()
	source := t.TempDir()
	filesystemRoot := t.TempDir()
	workspace := filepath.Join(filesystemRoot, "repository")
	t.Setenv("HOME", home)

	s := New("box")
	commands := [][]string{
		{"git", "init", "--initial-branch=main"},
		{"git", "add", "README.md"},
		{"git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"},
	}
	if err := os.WriteFile(filepath.Join(source, "README.md"), []byte("cloned\n"), 0644); err != nil {
		t.Fatal(err)
	}
	for _, command := range commands {
		if err := s.run(context.Background(), source, command...); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(filesystemRoot, "lost+found"), 0700); err != nil {
		t.Fatal(err)
	}

	response, err := s.Setup(context.Background(), connect.NewRequest(&v1.SetupRequest{
		RepositoryUrl: source,
		Workspace:     workspace,
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Ran {
		t.Fatal("setup did not run")
	}
	content, err := os.ReadFile(filepath.Join(workspace, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "cloned\n" {
		t.Fatalf("cloned content = %q", content)
	}
	if _, err := os.Stat(filepath.Join(workspace, "lost+found")); !os.IsNotExist(err) {
		t.Fatalf("lost+found entered the repository: %v", err)
	}
}
