package auth

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"strings"
	"time"

	"connectrpc.com/connect"
)

type Interceptor struct {
	Key       ed25519.PublicKey
	SandboxID string
	Now       func() time.Time
}

func ParsePublicKey(b []byte) (ed25519.PublicKey, error) {
	block, _ := pem.Decode(b)
	if block == nil {
		return nil, errors.New("invalid public key PEM")
	}
	value, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, err
	}
	key, ok := value.(ed25519.PublicKey)
	if !ok {
		return nil, errors.New("public key is not Ed25519")
	}
	return key, nil
}
func (a Interceptor) WrapUnary(next connect.UnaryFunc) connect.UnaryFunc {
	return func(ctx context.Context, request connect.AnyRequest) (connect.AnyResponse, error) {
		if err := a.verify(request.Header().Get("Authorization")); err != nil {
			return nil, connect.NewError(connect.CodeUnauthenticated, err)
		}
		return next(ctx, request)
	}
}
func (a Interceptor) WrapStreamingClient(next connect.StreamingClientFunc) connect.StreamingClientFunc {
	return next
}
func (a Interceptor) WrapStreamingHandler(next connect.StreamingHandlerFunc) connect.StreamingHandlerFunc {
	return func(ctx context.Context, connection connect.StreamingHandlerConn) error {
		if err := a.verify(connection.RequestHeader().Get("Authorization")); err != nil {
			return connect.NewError(connect.CodeUnauthenticated, err)
		}
		return next(ctx, connection)
	}
}
func (a Interceptor) verify(authorization string) error {
	if !strings.HasPrefix(authorization, "Bearer ") {
		return errors.New("missing bearer token")
	}
	parts := strings.Split(strings.TrimPrefix(authorization, "Bearer "), ".")
	if len(parts) != 3 {
		return errors.New("malformed token")
	}
	encoding := base64.RawURLEncoding
	header, err := encoding.DecodeString(parts[0])
	if err != nil {
		return errors.New("malformed token")
	}
	var protectedHeader struct {
		Alg string `json:"alg"`
	}
	if json.Unmarshal(header, &protectedHeader) != nil || protectedHeader.Alg != "EdDSA" {
		return errors.New("invalid algorithm")
	}
	signature, err := encoding.DecodeString(parts[2])
	if err != nil || !ed25519.Verify(a.Key, []byte(parts[0]+"."+parts[1]), signature) {
		return errors.New("invalid signature")
	}
	body, err := encoding.DecodeString(parts[1])
	if err != nil {
		return errors.New("malformed claims")
	}
	var claims struct {
		SandboxID string `json:"sandbox_id"`
		Exp       int64  `json:"exp"`
	}
	if json.Unmarshal(body, &claims) != nil {
		return errors.New("malformed claims")
	}
	now := time.Now()
	if a.Now != nil {
		now = a.Now()
	}
	if claims.SandboxID != a.SandboxID {
		return errors.New("wrong sandbox identity")
	}
	if claims.Exp <= now.Unix() {
		return errors.New("token expired")
	}
	return nil
}
