package credentials

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/zhming0/dsh-sandbox/runner/service"
)

func Serve(path string, s *service.Service) (net.Listener, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return nil, err
	}
	_ = os.Remove(path)
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, err
	}
	if err = os.Chmod(path, 0600); err != nil {
		_ = listener.Close()
		return nil, err
	}
	go func() {
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			go handle(connection, s)
		}
	}()
	return listener, nil
}
func handle(connection net.Conn, s *service.Service) {
	defer func() { _ = connection.Close() }()
	fields := readFields(connection)
	if fields["action"] != "get" {
		return
	}
	if credential, ok := s.Credential(fields["host"]); ok {
		// The peer is a short-lived git credential helper; if it is gone
		// there is nothing left to report the write failure to.
		_, _ = fmt.Fprintf(connection, "username=%s\npassword=%s\n\n", credential.Username, credential.Password)
	}
}
func readFields(r io.Reader) map[string]string {
	fields := map[string]string{}
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			break
		}
		if key, value, ok := strings.Cut(line, "="); ok {
			fields[key] = value
		}
	}
	return fields
}
func Helper(path, action string, in io.Reader, out io.Writer) error {
	if action != "get" {
		return nil
	}
	connection, err := net.Dial("unix", path)
	if err != nil {
		return err
	}
	defer func() { _ = connection.Close() }()
	if _, err := fmt.Fprintln(connection, "action=get"); err != nil {
		return err
	}
	fields := readFields(in)
	for key, value := range fields {
		if _, err := fmt.Fprintf(connection, "%s=%s\n", key, value); err != nil {
			return err
		}
	}
	if _, err := fmt.Fprintln(connection); err != nil {
		return err
	}
	if unixConnection, ok := connection.(*net.UnixConn); ok {
		_ = unixConnection.CloseWrite()
	}
	_, err = io.Copy(out, connection)
	return err
}
