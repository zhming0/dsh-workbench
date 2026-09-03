package credentials

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
	"github.com/zhming0/dsh-sandbox/runner/service"
)

func TestHelperGet(t *testing.T) {
	s := service.New("box")
	_, err := s.SetGitCredentials(context.Background(), connect.NewRequest(&v1.SetGitCredentialsRequest{Credentials: []*v1.GitCredential{{Host: "https://example.com/repo", Username: "u", Password: "secret"}}}))
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "c.sock")
	l, err := Serve(path, s)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Close() }()
	var out bytes.Buffer
	if err := Helper(path, "get", strings.NewReader("protocol=https\nhost=example.com\n\n"), &out); err != nil {
		t.Fatal(err)
	}
	if out.String() != "username=u\npassword=secret\n\n" {
		t.Fatalf("output = %q", out.String())
	}
}
