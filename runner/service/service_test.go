package service

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
)

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
