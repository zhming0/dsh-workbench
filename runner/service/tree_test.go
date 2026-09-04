package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
	"github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1/sandboxv1connect"
)

func newTreeClient(t *testing.T) sandboxv1connect.RunnerServiceClient {
	t.Helper()
	s := New("box")
	mux := http.NewServeMux()
	mux.Handle(sandboxv1connect.NewRunnerServiceHandler(s))
	server := httptest.NewUnstartedServer(mux)
	server.EnableHTTP2 = true
	server.StartTLS()
	t.Cleanup(server.Close)
	return sandboxv1connect.NewRunnerServiceClient(server.Client(), server.URL)
}

func relativePaths(entries []*v1.TreeEntry) []string {
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		paths = append(paths, entry.RelativePath)
	}
	sort.Strings(paths)
	return paths
}

func TestTreeListsRecursively(t *testing.T) {
	root := t.TempDir()
	writeTestFile(t, filepath.Join(root, "README.md"))
	writeTestFile(t, filepath.Join(root, "src", "index.ts"))
	writeTestFile(t, filepath.Join(root, "src", "nested", "deep.ts"))
	writeTestFile(t, filepath.Join(root, "vendor", "pkg", "lib.go"))
	writeTestFile(t, filepath.Join(root, ".github", "workflows", "ci.yml"))
	writeTestFile(t, filepath.Join(root, "node_modules", "dep", "index.js"))
	writeTestFile(t, filepath.Join(root, ".git", "HEAD"))
	if err := os.MkdirAll(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "src"), filepath.Join(root, "src-link")); err != nil {
		t.Fatal(err)
	}

	client := newTreeClient(t)
	response, err := client.Tree(context.Background(), connect.NewRequest(&v1.TreeRequest{
		Path: root,
		ExcludedDirectories: []string{
			".git", "node_modules", "dist", "build", "out", "coverage", "target",
			".next", ".nuxt", ".turbo", ".venv", "__pycache__", ".pytest_cache",
			".mypy_cache", ".gradle",
		},
	}))
	if err != nil {
		t.Fatal(err)
	}
	got := relativePaths(response.Msg.Entries)
	want := []string{
		".github",
		".github/workflows",
		".github/workflows/ci.yml",
		"README.md",
		"empty",
		"src",
		"src/index.ts",
		"src/nested",
		"src/nested/deep.ts",
		"vendor",
		"vendor/pkg",
		"vendor/pkg/lib.go",
	}
	if len(got) != len(want) {
		t.Fatalf("got %d entries %v, want %d", len(got), got, len(want))
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("entry %d = %q, want %q (all: %v)", index, got[index], want[index], got)
		}
	}
	if response.Msg.Truncated {
		t.Fatal("small tree must not be truncated")
	}
	// Symlinks are not offered and never descended.
	for _, entry := range response.Msg.Entries {
		if entry.Type == v1.FileType_FILE_TYPE_SYMLINK {
			t.Fatalf("symlink must not be returned: %+v", entry)
		}
	}
}

func TestTreeTruncatesAtCap(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"a.txt", "b.txt", "c.txt", "d.txt", "e.txt"} {
		writeTestFile(t, filepath.Join(root, name))
	}
	client := newTreeClient(t)
	response, err := client.Tree(context.Background(), connect.NewRequest(&v1.TreeRequest{Path: root, MaxEntries: 2}))
	if err != nil {
		t.Fatal(err)
	}
	if !response.Msg.Truncated {
		t.Fatal("expected truncated walk")
	}
	if len(response.Msg.Entries) != 2 {
		t.Fatalf("got %d entries, want 2: %v", len(response.Msg.Entries), relativePaths(response.Msg.Entries))
	}
}

func TestTreeMissingRoot(t *testing.T) {
	client := newTreeClient(t)
	_, err := client.Tree(context.Background(), connect.NewRequest(&v1.TreeRequest{Path: filepath.Join(t.TempDir(), "absent")}))
	if err == nil {
		t.Fatal("expected an error for a missing root")
	}
	if connect.CodeOf(err) != connect.CodeNotFound {
		t.Fatalf("got code %v, want %v", connect.CodeOf(err), connect.CodeNotFound)
	}
}

func TestTreeRejectsInvalidExcludedName(t *testing.T) {
	client := newTreeClient(t)
	_, err := client.Tree(context.Background(), connect.NewRequest(&v1.TreeRequest{
		Path:                t.TempDir(),
		ExcludedDirectories: []string{"a/b"},
	}))
	if err == nil {
		t.Fatal("expected an error for a separator-bearing excluded name")
	}
	if connect.CodeOf(err) != connect.CodeInvalidArgument {
		t.Fatalf("got code %v, want %v", connect.CodeOf(err), connect.CodeInvalidArgument)
	}
}

func writeTestFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
}
