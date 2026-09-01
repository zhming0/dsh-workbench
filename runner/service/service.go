package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"connectrpc.com/connect"
	v1 "github.com/zhming0/dsh-sandbox/runner/gen/dsh/sandbox/v1"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/metric"
)

const (
	defaultReadLimit = int64(16 << 20)
	defaultWorkspace = "/workspace/repository"
)

var execDuration metric.Float64Histogram

func init() {
	execDuration, _ = otel.Meter("dsh-runner").Float64Histogram(
		"dsh.sandbox.exec.duration",
		metric.WithUnit("s"),
		metric.WithDescription("Time spent running a command in the sandbox"),
	)
}

type Service struct {
	sandboxID   string
	mu          sync.RWMutex
	secrets     map[string]string
	credentials map[string]Credential
	locksMu     sync.Mutex
	locks       map[string]*sync.Mutex
}
type Credential struct{ Username, Password string }

func New(sandboxID string) *Service {
	return &Service{sandboxID: sandboxID, secrets: map[string]string{}, credentials: map[string]Credential{}, locks: map[string]*sync.Mutex{}}
}

func (s *Service) lock(path string) func() {
	absolutePath, _ := filepath.Abs(path)
	s.locksMu.Lock()
	pathLock := s.locks[absolutePath]
	if pathLock == nil {
		pathLock = &sync.Mutex{}
		s.locks[absolutePath] = pathLock
	}
	s.locksMu.Unlock()
	pathLock.Lock()
	return pathLock.Unlock
}
func cerr(code connect.Code, err error) error { return connect.NewError(code, err) }
func fileType(info os.FileInfo) v1.FileType {
	if info.Mode().IsRegular() {
		return v1.FileType_FILE_TYPE_REGULAR
	}
	if info.IsDir() {
		return v1.FileType_FILE_TYPE_DIRECTORY
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return v1.FileType_FILE_TYPE_SYMLINK
	}
	return v1.FileType_FILE_TYPE_OTHER
}
func version(info os.FileInfo) string {
	stat, _ := info.Sys().(*syscall.Stat_t)
	hash := sha256.New()
	if stat == nil {
		fmt.Fprintf(hash, "%d:%d:%d", info.Size(), info.ModTime().UnixNano(), info.Mode())
	} else {
		fmt.Fprintf(hash, "%d:%d:%d:%d:%d", stat.Dev, stat.Ino, info.Size(), info.ModTime().UnixNano(), info.Mode())
	}
	return hex.EncodeToString(hash.Sum(nil))
}
func stat(path string, follow bool) (os.FileInfo, error) {
	if follow {
		return os.Stat(path)
	}
	return os.Lstat(path)
}

func (s *Service) Health(_ context.Context, _ *connect.Request[v1.HealthRequest]) (*connect.Response[v1.HealthResponse], error) {
	_, err := os.Stat(filepath.Join(defaultWorkspace, ".dsh-setup-done"))
	return connect.NewResponse(&v1.HealthResponse{SandboxId: s.sandboxID, SetupComplete: err == nil}), nil
}

func safeBase() map[string]string {
	keep := []string{"PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "MISE_DATA_DIR", "MISE_CACHE_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"}
	environment := map[string]string{"PATH": "/usr/local/bin:/usr/bin:/bin"}
	for _, name := range keep {
		if value, ok := os.LookupEnv(name); ok {
			environment[name] = value
		}
	}
	return environment
}
func (s *Service) environment(extra map[string]string) []string {
	environment := safeBase()
	s.mu.RLock()
	for name, value := range s.secrets {
		environment[name] = value
	}
	s.mu.RUnlock()
	for name, value := range extra {
		environment[name] = value
	}
	result := make([]string, 0, len(environment))
	for name, value := range environment {
		result = append(result, name+"="+value)
	}
	sort.Strings(result)
	return result
}
func envValue(env []string, key string) string {
	for _, entry := range env {
		if strings.HasPrefix(entry, key+"=") {
			return strings.TrimPrefix(entry, key+"=")
		}
	}
	return ""
}

func (s *Service) Exec(ctx context.Context, request *connect.Request[v1.ExecRequest], stream *connect.ServerStream[v1.ExecResponse]) error {
	if len(request.Msg.Argv) == 0 {
		return cerr(connect.CodeInvalidArgument, errors.New("argv is required"))
	}
	execCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	startedAt := time.Now()
	defer func() {
		execDuration.Record(ctx, time.Since(startedAt).Seconds())
	}()
	cmd := exec.Command(request.Msg.Argv[0], request.Msg.Argv[1:]...)
	cmd.Dir = request.Msg.Cwd
	cmd.Env = s.environment(request.Msg.Env)
	// Empty stdin means "ignore": leave Stdin nil so the child reads the null
	// device. Wiring an empty pipe instead would make tools that fall back to
	// their workdir only for non-pipe stdin — ripgrep among them — silently
	// search nothing.
	if len(request.Msg.Stdin) > 0 {
		cmd.Stdin = bytes.NewReader(request.Msg.Stdin)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return cerr(connect.CodeInternal, err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return cerr(connect.CodeInternal, err)
	}
	if err := cmd.Start(); err != nil {
		return cerr(connect.CodeInvalidArgument, err)
	}
	type chunk struct {
		data   []byte
		stderr bool
	}
	chunks := make(chan chunk, 16)
	var wg sync.WaitGroup
	copyPipe := func(reader io.Reader, isStderr bool) {
		defer wg.Done()
		buffer := make([]byte, 32<<10)
		for {
			count, readError := reader.Read(buffer)
			if count > 0 {
				select {
				case chunks <- chunk{data: append([]byte(nil), buffer[:count]...), stderr: isStderr}:
				case <-execCtx.Done():
					return
				}
			}
			if readError != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyPipe(stdout, false)
	go copyPipe(stderr, true)
	go func() { wg.Wait(); close(chunks) }()
	var commandError error
	waitDone := make(chan struct{})
	go func() {
		commandError = cmd.Wait()
		close(waitDone)
	}()
	go func() {
		select {
		case <-execCtx.Done():
			terminateProcessGroup(cmd.Process.Pid, waitDone)
		case <-waitDone:
		}
	}()
	if err := stream.Send(&v1.ExecResponse{Event: &v1.ExecResponse_Started{Started: &v1.ExecStarted{Pid: int64(cmd.Process.Pid)}}}); err != nil {
		cancel()
		<-waitDone
		return err
	}
	for chunk := range chunks {
		var sendError error
		if chunk.stderr {
			sendError = stream.Send(&v1.ExecResponse{Event: &v1.ExecResponse_Stderr{Stderr: chunk.data}})
		} else {
			sendError = stream.Send(&v1.ExecResponse{Event: &v1.ExecResponse_Stdout{Stdout: chunk.data}})
		}
		if sendError != nil {
			cancel()
			<-waitDone
			return sendError
		}
	}
	<-waitDone
	if ctx.Err() != nil {
		return ctx.Err()
	}
	exit := &v1.ExecExited{}
	if commandError != nil {
		if exitError, ok := commandError.(*exec.ExitError); ok {
			exit.ExitCode = int32(exitError.ExitCode())
			if waitStatus, ok := exitError.Sys().(syscall.WaitStatus); ok && waitStatus.Signaled() {
				exit.Signal = waitStatus.Signal().String()
			}
		} else {
			return cerr(connect.CodeInternal, commandError)
		}
	}
	return stream.Send(&v1.ExecResponse{Event: &v1.ExecResponse_Exited{Exited: exit}})
}

func terminateProcessGroup(pid int, done <-chan struct{}) {
	select {
	case <-done:
		return
	default:
	}
	_ = syscall.Kill(-pid, syscall.SIGTERM)
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	select {
	case <-done:
		return
	case <-timer.C:
		_ = syscall.Kill(-pid, syscall.SIGKILL)
		<-done
	}
}

func (s *Service) ResolveExecutable(_ context.Context, request *connect.Request[v1.ResolveExecutableRequest]) (*connect.Response[v1.ResolveExecutableResponse], error) {
	command := request.Msg.Command
	if command == "" {
		return nil, cerr(connect.CodeInvalidArgument, errors.New("command required"))
	}
	if strings.ContainsRune(command, os.PathSeparator) {
		path, err := filepath.Abs(command)
		if err != nil {
			return nil, cerr(connect.CodeInvalidArgument, err)
		}
		if info, err := os.Stat(path); err != nil || info.Mode()&0111 == 0 {
			return nil, cerr(connect.CodeNotFound, errors.New("executable not found"))
		}
		return connect.NewResponse(&v1.ResolveExecutableResponse{Path: path}), nil
	}
	for _, directory := range filepath.SplitList(envValue(s.environment(request.Msg.Env), "PATH")) {
		path := filepath.Join(directory, command)
		if info, err := os.Stat(path); err == nil && !info.IsDir() && info.Mode()&0111 != 0 {
			path, _ = filepath.Abs(path)
			return connect.NewResponse(&v1.ResolveExecutableResponse{Path: path}), nil
		}
	}
	return nil, cerr(connect.CodeNotFound, errors.New("executable not found"))
}
func resolve(path, cwd string) (string, string, error) {
	if path == "" {
		return "", "", errors.New("path required")
	}
	if !filepath.IsAbs(path) {
		if cwd == "" {
			cwd = "."
		}
		path = filepath.Join(cwd, path)
	}
	display, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", "", err
	}
	canonical, err := filepath.EvalSymlinks(display)
	if os.IsNotExist(err) {
		parent, parentError := filepath.EvalSymlinks(filepath.Dir(display))
		if parentError == nil {
			canonical = filepath.Join(parent, filepath.Base(display))
			err = nil
		}
	}
	return display, canonical, err
}
func (s *Service) ResolvePath(_ context.Context, request *connect.Request[v1.ResolvePathRequest]) (*connect.Response[v1.ResolvePathResponse], error) {
	display, canonical, err := resolve(request.Msg.Path, request.Msg.Cwd)
	if err != nil {
		return nil, cerr(connect.CodeNotFound, err)
	}
	return connect.NewResponse(&v1.ResolvePathResponse{DisplayPath: display, CanonicalPath: canonical}), nil
}
func (s *Service) ReadFile(_ context.Context, request *connect.Request[v1.ReadFileRequest]) (*connect.Response[v1.ReadFileResponse], error) {
	limit := request.Msg.MaxBytes
	if limit <= 0 {
		limit = defaultReadLimit
	}
	file, err := os.Open(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeNotFound, err)
	}
	defer file.Close()
	content, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	if int64(len(content)) > limit {
		return nil, cerr(connect.CodeResourceExhausted, errors.New("file exceeds max_bytes"))
	}
	return connect.NewResponse(&v1.ReadFileResponse{Content: content}), nil
}
func atomicWrite(path string, content []byte, mode os.FileMode) error {
	directory := filepath.Dir(path)
	file, err := os.CreateTemp(directory, ".dsh-write-")
	if err != nil {
		return err
	}
	temporaryPath := file.Name()
	defer os.Remove(temporaryPath)
	if err = file.Chmod(mode); err == nil {
		_, err = file.Write(content)
	}
	if err == nil {
		err = file.Sync()
	}
	if closeError := file.Close(); err == nil {
		err = closeError
	}
	if err == nil {
		err = os.Rename(temporaryPath, path)
	}
	return err
}

func (s *Service) WriteFile(_ context.Context, request *connect.Request[v1.WriteFileRequest]) (*connect.Response[v1.WriteFileResponse], error) {
	unlock := s.lock(request.Msg.Path)
	defer unlock()
	before, err := os.ReadFile(request.Msg.Path)
	exists := err == nil
	if err != nil && !os.IsNotExist(err) {
		return nil, cerr(connect.CodeInternal, err)
	}
	var info os.FileInfo
	if exists {
		info, err = os.Stat(request.Msg.Path)
		if err != nil {
			return nil, cerr(connect.CodeFailedPrecondition, errors.New("file changed while it was being read"))
		}
	}
	switch guard := request.Msg.Guard.(type) {
	case *v1.WriteFileRequest_CreateIfAbsent:
		if guard.CreateIfAbsent && exists {
			return nil, cerr(connect.CodeAlreadyExists, errors.New("file exists"))
		}
	case *v1.WriteFileRequest_ExpectedVersion:
		if !exists || version(info) != guard.ExpectedVersion {
			return nil, cerr(connect.CodeFailedPrecondition, errors.New("version mismatch"))
		}
	}
	mode := os.FileMode(0644)
	if info != nil {
		mode = info.Mode().Perm()
	}
	if err := os.MkdirAll(filepath.Dir(request.Msg.Path), 0755); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	if err := atomicWrite(request.Msg.Path, request.Msg.Content, mode); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	newInfo, err := os.Stat(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	return connect.NewResponse(&v1.WriteFileResponse{Created: !exists, HadBefore: exists, Before: before, Version: version(newInfo)}), nil
}
func (s *Service) EditFile(_ context.Context, request *connect.Request[v1.EditFileRequest]) (*connect.Response[v1.EditFileResponse], error) {
	unlock := s.lock(request.Msg.Path)
	defer unlock()
	before, err := os.ReadFile(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeNotFound, err)
	}
	info, err := os.Stat(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeNotFound, err)
	}
	if request.Msg.ExpectedVersion != "" && request.Msg.ExpectedVersion != version(info) {
		return nil, cerr(connect.CodeFailedPrecondition, errors.New("version mismatch"))
	}
	if request.Msg.OldString == "" {
		return nil, cerr(connect.CodeInvalidArgument, errors.New("old_string must not be empty"))
	}
	count := bytes.Count(before, []byte(request.Msg.OldString))
	if count == 0 {
		return nil, cerr(connect.CodeNotFound, errors.New("old_string not found"))
	}
	if count > 1 && !request.Msg.ReplaceAll {
		return nil, cerr(connect.CodeFailedPrecondition, errors.New("old_string is ambiguous"))
	}
	limit := 1
	if request.Msg.ReplaceAll {
		limit = -1
	}
	after := bytes.Replace(before, []byte(request.Msg.OldString), []byte(request.Msg.NewString), limit)
	if err := atomicWrite(request.Msg.Path, after, info.Mode().Perm()); err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	newInfo, err := os.Stat(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeInternal, err)
	}
	return connect.NewResponse(&v1.EditFileResponse{Before: before, After: after, Version: version(newInfo)}), nil
}
func (s *Service) Stat(_ context.Context, request *connect.Request[v1.StatRequest]) (*connect.Response[v1.StatResponse], error) {
	info, err := stat(request.Msg.Path, request.Msg.FollowSymlinks)
	if os.IsNotExist(err) {
		return connect.NewResponse(&v1.StatResponse{}), nil
	}
	if err != nil {
		return nil, cerr(connect.CodePermissionDenied, err)
	}
	return connect.NewResponse(&v1.StatResponse{Exists: true, Type: fileType(info), Size: info.Size(), Version: version(info)}), nil
}
func (s *Service) List(_ context.Context, request *connect.Request[v1.ListRequest]) (*connect.Response[v1.ListResponse], error) {
	entries, err := os.ReadDir(request.Msg.Path)
	if err != nil {
		return nil, cerr(connect.CodeNotFound, err)
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	response := &v1.ListResponse{}
	for _, entry := range entries {
		path := filepath.Join(request.Msg.Path, entry.Name())
		info, err := os.Lstat(path)
		if err != nil {
			continue
		}
		_, canonical, err := resolve(path, "")
		if err != nil {
			canonical, _ = filepath.Abs(path)
		}
		response.Entries = append(response.Entries, &v1.ListEntry{Name: entry.Name(), CanonicalPath: canonical, Type: fileType(info), Size: info.Size(), Version: version(info)})
	}
	return connect.NewResponse(response), nil
}
func (s *Service) SetSecrets(_ context.Context, request *connect.Request[v1.SetSecretsRequest]) (*connect.Response[v1.SetSecretsResponse], error) {
	secrets := make(map[string]string, len(request.Msg.Secrets))
	for name, value := range request.Msg.Secrets {
		if name == "" || strings.ContainsAny(name, "=\x00") {
			return nil, cerr(connect.CodeInvalidArgument, errors.New("invalid environment name"))
		}
		secrets[name] = value
	}
	s.mu.Lock()
	s.secrets = secrets
	s.mu.Unlock()
	return connect.NewResponse(&v1.SetSecretsResponse{}), nil
}
func (s *Service) SetGitCredentials(_ context.Context, request *connect.Request[v1.SetGitCredentialsRequest]) (*connect.Response[v1.SetGitCredentialsResponse], error) {
	credentials := map[string]Credential{}
	for _, credential := range request.Msg.Credentials {
		host := normalizeHost(credential.Host)
		if host == "" {
			return nil, cerr(connect.CodeInvalidArgument, errors.New("credential host required"))
		}
		credentials[host] = Credential{credential.Username, credential.Password}
	}
	s.mu.Lock()
	s.credentials = credentials
	s.mu.Unlock()
	return connect.NewResponse(&v1.SetGitCredentialsResponse{}), nil
}
func normalizeHost(host string) string {
	host = strings.TrimSpace(host)
	if protocolEnd := strings.Index(host, "://"); protocolEnd >= 0 {
		host = host[protocolEnd+3:]
	}
	host = strings.Split(host, "/")[0]
	return strings.ToLower(host)
}
func (s *Service) Credential(host string) (Credential, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	credential, ok := s.credentials[normalizeHost(host)]
	return credential, ok
}
