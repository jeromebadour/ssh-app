package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/lab/hostile"
)

func askWho(t *testing.T, addr string) *proc {
	t.Helper()
	p := start(t)
	aim, _ := json.Marshal(map[string]any{"v": 1, "role": "identify", "box": map[string]any{"addr": addr}})
	p.send(t, frame.TypeAim, aim)
	f := p.read(t)
	var hello map[string]any
	if f.Type != frame.TypeHello || json.Unmarshal(f.Body, &hello) != nil || hello["role"] != "identify" {
		t.Fatalf("no Hello as a first-connection check: type %d %s", f.Type, f.Body)
	}
	return p
}

// whoStates reads State frames until one is final ("identified" or "ended"), and returns them all.
func whoStates(t *testing.T, p *proc) []map[string]any {
	t.Helper()
	var all []map[string]any
	for {
		f := p.read(t)
		if f.Type != frame.TypeState {
			t.Fatalf("a frame of type %d from a first-connection check: %s", f.Type, f.Body)
		}
		var v map[string]any
		if err := json.Unmarshal(f.Body, &v); err != nil {
			t.Fatal(err)
		}
		all = append(all, v)
		if v["state"] == "identified" || v["state"] == "ended" {
			return all
		}
	}
}

// The whole of a first-connection check: each phase said, then the box's identity as its kind, its
// fingerprint and the key; the process ends; and the box was never asked to let anyone in.
func TestIdentifySaysWhoTheBoxIs(t *testing.T) {
	host := newKey(t)
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: newKey(t).PublicKey(), Sessions: true})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	p := askWho(t, box.Addr())
	got := whoStates(t, p)
	if len(got) != 3 || got[0]["state"] != "connecting" || got[1]["state"] != "key-exchange" {
		t.Fatalf("said: %v", got)
	}
	last := got[2]
	if last["state"] != "identified" || last["type"] != "ssh-ed25519" || last["fingerprint"] != ssh.FingerprintSHA256(host.PublicKey()) || last["key"] != line(host.PublicKey()) {
		t.Fatalf("the answer is not the box's identity: %v", last)
	}
	if !strings.HasPrefix(last["fingerprint"].(string), "SHA256:") || len(last["fingerprint"].(string)) != 50 {
		t.Fatalf("not a SHA-256 fingerprint in OpenSSH's form: %v", last["fingerprint"])
	}
	if code := p.exit(t); code != exitOK {
		t.Fatalf("exit %d", code)
	}
	if n, users := box.SignInTries(); n != 0 || len(users) != 0 || len(box.Sessions()) != 0 {
		t.Fatalf("the box saw %d sign-in tries (users %q) and %d sessions; it must see none", n, users, len(box.Sessions()))
	}
}

// Why there is no answer is said with the same causes a tab's link has, the two lists on their right sides.
func TestIdentifySaysWhyNot(t *testing.T) {
	t.Run("nothing listening", func(t *testing.T) {
		box, _ := hostile.Start(hostile.Config{HostSigner: newKey(t)})
		addr := box.Addr()
		box.Close()
		p := askWho(t, addr)
		got := whoStates(t, p)
		if last := got[len(got)-1]; last["state"] != "ended" || last["cause"] != "refused" || last["phase"] != "connecting" {
			t.Fatalf("%v", last)
		}
		if code := p.exit(t); code != exitOK {
			t.Fatalf("exit %d", code)
		}
	})
	t.Run("a box with only a weaker cipher", func(t *testing.T) {
		box, _ := hostile.Start(hostile.Config{HostSigner: newKey(t), Ciphers: []string{ssh.CipherChaCha20Poly1305}})
		defer box.Close()
		p := askWho(t, box.Addr())
		got := whoStates(t, p)
		last := got[len(got)-1]
		ours, _ := json.Marshal(last["ours"])
		theirs, _ := json.Marshal(last["box"])
		if last["cause"] != "weak-offer" || last["what"] != "cipher" || !strings.Contains(string(ours), "aes256-gcm") || !strings.Contains(string(theirs), "chacha20") || strings.Contains(string(theirs), "gcm") {
			t.Fatalf("%v", last)
		}
	})
}

// It answers the heartbeat while it waits on a box, ends at once when main closes its input, and takes no
// other frame: there is nothing a first-connection check can be asked to do.
func TestIdentifyHeartbeatAndEnd(t *testing.T) {
	silent, _ := hostile.Start(hostile.Config{HostSigner: newKey(t), Silent: true})
	defer silent.Close()

	p := askWho(t, silent.Addr())
	p.send(t, frame.TypePing, []byte("still there?"))
	deadline := time.Now().Add(3 * time.Second)
	for {
		f := p.read(t)
		if f.Type == frame.TypePong && string(f.Body) == "still there?" {
			break
		}
		if f.Type != frame.TypeState || time.Now().After(deadline) {
			t.Fatalf("no Pong while waiting on a silent box (type %d)", f.Type)
		}
	}
	began := time.Now()
	p.in.Close()
	if code := p.exit(t); code != exitOK || time.Since(began) > 2*time.Second {
		t.Fatalf("exit %d after %v; wanted 0 at once", code, time.Since(began))
	}

	for _, typ := range []byte{frame.TypeSignReply, frame.TypeInput, frame.TypeAim, frame.TypeKeyRequest, frame.TypePassword} {
		p := askWho(t, silent.Addr())
		p.send(t, typ, []byte(`{}`))
		for {
			f := p.read(t)
			if f.Type == frame.TypeFatal {
				break
			}
			if f.Type != frame.TypeState {
				t.Fatalf("frame type %d was taken by a first-connection check", typ)
			}
		}
		if code := p.exit(t); code != exitBadFrame {
			t.Fatalf("frame type %d: exit %d, wanted %d", typ, code, exitBadFrame)
		}
	}
}

// An Aim it cannot be: no box to ask, or a role that does not exist.
func TestIdentifyBadAims(t *testing.T) {
	for _, aim := range []string{`{"v":1,"role":"identify"}`, `{"v":1,"role":"identify","box":{"addr":""}}`, `{"v":1,"role":"anything","tab":"1","stub":true}`} {
		p := start(t)
		p.send(t, frame.TypeAim, []byte(aim))
		if f := p.read(t); f.Type != frame.TypeFatal {
			t.Fatalf("%s: answered with type %d", aim, f.Type)
		}
		if code := p.exit(t); code != exitNoAim {
			t.Fatalf("%s: exit %d", aim, code)
		}
	}
}
