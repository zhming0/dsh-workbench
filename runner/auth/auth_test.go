package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"testing"
	"time"
)

func token(t *testing.T, private ed25519.PrivateKey, sandbox string, exp int64) string {
	t.Helper()
	e := base64.RawURLEncoding
	h := e.EncodeToString([]byte(`{"alg":"EdDSA"}`))
	p := e.EncodeToString([]byte(fmt.Sprintf(`{"sandbox_id":%q,"exp":%d}`, sandbox, exp)))
	s := ed25519.Sign(private, []byte(h+"."+p))
	return h + "." + p + "." + e.EncodeToString(s)
}

func TestVerify(t *testing.T) {
	pub, private, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1000, 0)
	a := Interceptor{Key: pub, SandboxID: "box", Now: func() time.Time { return now }}
	for _, tc := range []struct {
		name, bearer string
		ok           bool
	}{
		{"missing", "", false},
		{"wrong identity", "Bearer " + token(t, private, "other", 1100), false},
		{"expired", "Bearer " + token(t, private, "box", 999), false},
		{"success", "Bearer " + token(t, private, "box", 1100), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := a.verify(tc.bearer)
			if (err == nil) != tc.ok {
				t.Fatalf("verify error = %v", err)
			}
		})
	}
}
