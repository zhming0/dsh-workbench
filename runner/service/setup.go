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

// setupMarkerPath is the durable record that a workspace's one-time setup ran.
// It lives inside the repository's own .git directory, so it never appears in
// `git status` and never burdens the model with an untracked file to add.
func setupMarkerPath(workspace string) string {
	return filepath.Join(workspace, ".git", ".agents-setup-done")
}

// agentHookPath resolves a repository's `.agents/<name>` hook and returns it
// only when it exists and is executable. The names are `setup` (one-time) and
// `resume` (run on every wake, must be idempotent).
func agentHookPath(workspace, name string) (string, bool) {
	path := filepath.Join(workspace, ".agents", name)
	info, err := os.Stat(path)
	if err != nil || info.Mode()&0111 == 0 {
		return "", false
	}
	return path, true
}

func (s *Service) Setup(ctx context.Context, request *connect.Request[v1.SetupRequest]) (*connect.Response[v1.SetupResponse], error) {
	workspace := request.Msg.Workspace
	if workspace == "" {
		workspace = defaultWorkspace
	}
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, cerr(connect.CodeInvalidArgument, err)
	}
	if err := os.MkdirAll(workspace, 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	marker := setupMarkerPath(workspace)
	unlock := s.lock(marker)
	defer unlock()
	if err := s.run(ctx, workspace, "git", "config", "--global", "credential.helper", "!dsh-runner git-credential"); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}

	// A present marker means the one-time setup already ran: this is a resume,
	// so re-warm with the idempotent `.agents/resume` hook and never re-clone or
	// re-run the one-time `.agents/setup`.
	if _, markerError := os.Stat(marker); markerError == nil {
		ran := false
		if path, ok := agentHookPath(workspace, "resume"); ok {
			if err := s.run(ctx, workspace, path); err != nil {
				return nil, cerr(connect.CodeInternal, err)
			}
			ran = true
		}
		return connect.NewResponse(&v1.SetupResponse{Ran: ran}), nil
	} else if !os.IsNotExist(markerError) {
		return nil, cerr(connect.CodeInternal, markerError)
	}

	// Fresh provision: initialize the repository, then run the one-time setup.
	_, gitError := os.Stat(filepath.Join(workspace, ".git"))
	if gitError != nil && !os.IsNotExist(gitError) {
		return nil, cerr(connect.CodeInternal, gitError)
	}
	cloned := false
	if os.IsNotExist(gitError) {
		entries, readError := os.ReadDir(workspace)
		if readError != nil {
			return nil, cerr(connect.CodeInternal, readError)
		}
		if len(entries) != 0 {
			return nil, cerr(connect.CodeFailedPrecondition, errors.New("workspace is not empty"))
		}
		if request.Msg.RepositoryUrl == "" {
			return nil, cerr(connect.CodeInvalidArgument, errors.New("repository_url required"))
		}
		if err := s.run(ctx, filepath.Dir(workspace), "git", "clone", request.Msg.RepositoryUrl, workspace); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
		cloned = true
	}
	// Only move the checkout to the requested revision on a fresh clone. A
	// resume never reaches here, and a pre-initialized workspace must not have
	// its working tree reset by a revision it did not just request.
	if cloned && request.Msg.Revision != "" {
		if err := s.run(ctx, workspace, "git", "checkout", request.Msg.Revision); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	if path, ok := agentHookPath(workspace, "setup"); ok {
		if err := s.run(ctx, workspace, path); err != nil {
			return nil, cerr(connect.CodeInternal, err)
		}
	}
	// The marker sits inside .git, which a clone (or a pre-initialized
	// workspace) has already created.
	if err := atomicWrite(marker, []byte("complete\n"), 0644); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	return connect.NewResponse(&v1.SetupResponse{Ran: true}), nil
}

func processGroup() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
