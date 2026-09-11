package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureHomeCreatesMissingDirectory(t *testing.T) {
	home := filepath.Join(t.TempDir(), "workspace", "home")
	t.Setenv("HOME", home)
	if err := ensureHome(); err != nil {
		t.Fatalf("ensureHome: %v", err)
	}
	info, err := os.Stat(home)
	if err != nil || !info.IsDir() {
		t.Fatalf("home directory not created: %v", err)
	}
	// A wake remounts the volume with the directory already there.
	if err := ensureHome(); err != nil {
		t.Fatalf("ensureHome on an existing directory: %v", err)
	}
}

func TestEnsureHomeWithoutHome(t *testing.T) {
	t.Setenv("HOME", "")
	if err := ensureHome(); err != nil {
		t.Fatalf("ensureHome without HOME: %v", err)
	}
}
