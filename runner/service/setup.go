package service

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
)

func (s *Service) run(ctx context.Context, dir string, argv ...string) error {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir, cmd.Env = dir, s.environment(nil)
	cmd.SysProcAttr = processGroup()
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	var commandError error
	done := make(chan struct{})
	go func() {
		commandError = cmd.Wait()
		close(done)
	}()
	select {
	case <-done:
		return commandError
	case <-ctx.Done():
		terminateProcessGroup(cmd.Process.Pid, done)
		return ctx.Err()
	}
}

func (s *Service) cloneRepository(ctx context.Context, repositoryURL, workspace string, preserveFilesystemRoot bool) error {
	if !preserveFilesystemRoot {
		return s.run(ctx, filepath.Dir(workspace), "git", "clone", repositoryURL, workspace)
	}

	// A freshly formatted persistent volume can contain lost+found. Git will
	// not clone into that non-empty root, so stage the checkout on the same
	// volume and move it into place without removing filesystem metadata.
	staging, err := os.MkdirTemp(workspace, ".dsh-clone-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	if err := s.run(ctx, workspace, "git", "clone", repositoryURL, staging); err != nil {
		return err
	}
	entries, err := os.ReadDir(staging)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		_, err := os.Lstat(filepath.Join(workspace, entry.Name()))
		if err == nil {
			return errors.New("repository contains a path reserved by workspace filesystem")
		}
		if !os.IsNotExist(err) {
			return err
		}
	}
	for _, entry := range entries {
		if entry.Name() == ".git" {
			continue
		}
		if err := os.Rename(filepath.Join(staging, entry.Name()), filepath.Join(workspace, entry.Name())); err != nil {
			return err
		}
	}
	return os.Rename(filepath.Join(staging, ".git"), filepath.Join(workspace, ".git"))
}

func (s *Service) Setup(ctx context.Context, request *connect.Request[v1.SetupRequest]) (*connect.Response[v1.SetupResponse], error) {
	workspace := request.Msg.Workspace
	if workspace == "" {
		workspace = "/workspace"
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, cerr(connect.CodeInvalidArgument, err)
	}
	if err := os.MkdirAll(workspace, 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	unlock := s.lock(filepath.Join(workspace, ".dsh-setup-done"))
	defer unlock()
	if err := s.run(ctx, workspace, "git", "config", "--global", "credential.helper", "!dsh-runner git-credential"); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	marker := filepath.Join(workspace, ".dsh-setup-done")
	_, markerError := os.Stat(marker)
	if markerError == nil {
		return connect.NewResponse(&v1.SetupResponse{}), nil
	}
	if !os.IsNotExist(markerError) {
		return nil, cerr(connect.CodeInternal, markerError)
	}
	_, gitError := os.Stat(filepath.Join(workspace, ".git"))
	if gitError != nil && !os.IsNotExist(gitError) {
		return nil, cerr(connect.CodeInternal, gitError)
	}
	if os.IsNotExist(gitError) {
		entries, readError := os.ReadDir(workspace)
		if readError != nil {
			return nil, cerr(connect.CodeInternal, readError)
		}
		preserveFilesystemRoot := len(entries) == 1 && entries[0].Name() == "lost+found" && entries[0].IsDir()
		if len(entries) != 0 && !preserveFilesystemRoot {
			return nil, cerr(connect.CodeFailedPrecondition, errors.New("workspace is not empty"))
		}
		if request.Msg.RepositoryUrl == "" {
			return nil, cerr(connect.CodeInvalidArgument, errors.New("repository_url required"))
		}
		if err := s.cloneRepository(ctx, request.Msg.RepositoryUrl, workspace, preserveFilesystemRoot); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	if request.Msg.Revision != "" {
		if err := s.run(ctx, workspace, "git", "checkout", request.Msg.Revision); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	script := filepath.Join(workspace, ".dsh", "setup.sh")
	if info, err := os.Stat(script); err == nil && info.Mode()&0111 != 0 {
		if err := s.run(ctx, workspace, script); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	if err := atomicWrite(marker, []byte("complete\n"), 0644); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	return connect.NewResponse(&v1.SetupResponse{Ran: true}), nil
}

func processGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
