package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
)

const goodPassword = "a long enough password"

// kp is a test standing in for main, speaking to a key process.
type kp struct {
	t    *testing.T
	p    *proc
	next uint64
}

func startKeys(t *testing.T, file string) *kp {
	t.Helper()
	p := start(t)
	aim, _ := json.Marshal(map[string]any{"v": 1, "role": "keys", "file": file, "cost": map[string]any{"time": 1, "memoryKiB": 65536, "threads": 2}})
	p.send(t, frame.TypeAim, aim)
	if h := p.read(t); h.Type != frame.TypeHello || !bytes.Contains(h.Body, []byte(`"role":"keys"`)) {
		t.Fatalf("hello: %#x %s", h.Type, h.Body)
	}
	return &kp{t: t, p: p}
}

func (k *kp) answer() map[string]any {
	k.t.Helper()
	f := k.p.read(k.t)
	var v map[string]any
	if f.Type != frame.TypeKeyReply || json.Unmarshal(f.Body, &v) != nil || v["id"] != float64(k.next) {
		k.t.Fatalf("answer: %#x %s (asked %d)", f.Type, f.Body, k.next)
	}
	return v
}

func (k *kp) ask(op string, fields map[string]any) map[string]any {
	k.t.Helper()
	k.next++
	q := map[string]any{"id": k.next, "op": op}
	for name, v := range fields {
		q[name] = v
	}
	body, _ := json.Marshal(q)
	k.p.send(k.t, frame.TypeKeyRequest, body)
	return k.answer()
}

func (k *kp) password(op byte, rest []byte) map[string]any {
	k.t.Helper()
	k.next++
	body := binary.BigEndian.AppendUint64(nil, k.next)
	body = append(body, op)
	k.p.send(k.t, frame.TypePassword, append(body, rest...))
	return k.answer()
}

func signIn(t *testing.T, publicKey, user string) []byte {
	t.Helper()
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(publicKey))
	if err != nil {
		t.Fatal(err)
	}
	s := func(b []byte) []byte { return append(binary.BigEndian.AppendUint32(nil, uint32(len(b))), b...) }
	var d []byte
	d = append(d, s(bytes.Repeat([]byte{5}, 32))...)
	d = append(d, 50)
	d = append(d, s([]byte(user))...)
	d = append(d, s([]byte("ssh-connection"))...)
	d = append(d, s([]byte("publickey"))...)
	d = append(d, 1)
	d = append(d, s([]byte("ssh-ed25519"))...)
	return append(d, s(pub.Marshal())...)
}

// The key process's whole life: nothing before a password; the first password makes the list; a key is made
// and signs its box's sign-in; the list is on disk sealed; a new process needs the password again.
func TestTheKeyProcess(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "list.berth")
	k := startKeys(t, file)

	if s := k.ask("status", nil); s["exists"] != false || s["unlocked"] != false {
		t.Fatalf("status: %v", s)
	}
	for _, op := range []string{"keys", "sign", "newKey", "setPublic", "setBackupDir", "deleteKey", "rebind"} {
		if a := k.ask(op, nil); a["error"] != "locked" {
			t.Fatalf("%s before any password: %v", op, a)
		}
	}
	if a := k.password(pwUnlock, []byte(goodPassword)); a["error"] != "no-list" {
		t.Fatalf("unlock with no list: %v", a)
	}
	if a := k.password(pwCreate, []byte("too short")); a["error"] != "password-too-short" {
		t.Fatalf("a short password: %v", a)
	}
	if a := k.password(pwCreate, []byte("eleven char")); a["error"] != "password-too-short" {
		t.Fatalf("eleven characters: %v", a)
	}
	if a := k.password(pwCreate, []byte(goodPassword)); a["ok"] != true {
		t.Fatalf("create: %v", a)
	}

	made := k.ask("newKey", map[string]any{"name": "k1", "box": "box-a", "user": "demo"})
	pub, _ := made["publicKey"].(string)
	if made["ok"] != true || made["backup"] != "none" || made["savedAt"] == nil {
		t.Fatalf("newKey: %v", made)
	}
	data := signIn(t, pub, "demo")
	signed := k.ask("sign", map[string]any{"key": "k1", "box": "box-a", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString(data)})
	raw, _ := base64.StdEncoding.DecodeString(signed["signature"].(string))
	sig := new(ssh.Signature)
	key, _, _, _, _ := ssh.ParseAuthorizedKey([]byte(pub))
	if ssh.Unmarshal(raw, sig) != nil || key.Verify(data, sig) != nil {
		t.Fatal("the signature does not verify")
	}
	for name, q := range map[string]map[string]any{
		"not-this-box":  {"key": "k1", "box": "box-b", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString(data)},
		"no-such-key":   {"key": "k7", "box": "box-a", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString(data)},
		"not-a-sign-in": {"key": "k1", "box": "box-a", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString(signIn(t, pub, "root"))},
	} {
		if a := k.ask("sign", q); a["error"] != name || a["signature"] != nil {
			t.Fatalf("wanted %s: %v", name, a)
		}
	}
	if a := k.ask("sign", map[string]any{"key": "k1", "box": "box-a", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString([]byte("sign this message"))}); a["error"] != "not-a-sign-in" {
		t.Fatalf("a message that is no sign-in: %v", a)
	}

	backups := filepath.Join(dir, "backups")
	_ = os.Mkdir(backups, 0o700)
	if a := k.ask("setPublic", map[string]any{"public": map[string]any{"boxes": []any{map[string]any{"id": "box-a", "name": "demo-eu"}}}}); a["ok"] != true {
		t.Fatal(a)
	}
	if a := k.ask("setBackupDir", map[string]any{"dir": backups}); a["backup"] != "written" {
		t.Fatalf("setBackupDir: %v", a)
	}
	if a := k.ask("setBackupDir", map[string]any{"dir": "relative/folder"}); a["error"] != "refused" {
		t.Fatal(a)
	}
	onDisk, _ := os.ReadFile(file)
	if len(onDisk) == 0 || bytes.Contains(onDisk, []byte("demo")) || bytes.Contains(onDisk, []byte("box-a")) {
		t.Fatal("the list on disk is missing or readable")
	}

	// The process ends with main; a new one knows nothing until the password.
	_ = k.p.in.Close()
	if code := k.p.exit(t); code != exitOK {
		t.Fatalf("exit %d", code)
	}
	k = startKeys(t, file)
	if s := k.ask("status", nil); s["exists"] != true || s["unlocked"] != false || s["hasPrevious"] != true {
		t.Fatalf("status: %v", s)
	}
	if a := k.ask("keys", nil); a["error"] != "locked" {
		t.Fatal(a)
	}
	if a := k.password(pwCreate, []byte(goodPassword)); a["error"] != "exists" {
		t.Fatalf("a second create over a list: %v", a)
	}
	open := k.password(pwUnlock, []byte(goodPassword))
	list, _ := open["keys"].([]any)
	if open["ok"] != true || len(list) != 1 || list[0].(map[string]any)["publicKey"] != pub || open["backupDir"] != backups || open["savedAt"] == nil {
		t.Fatalf("unlock: %v", open)
	}
	if p, _ := json.Marshal(open["public"]); string(p) != `{"boxes":[{"id":"box-a","name":"demo-eu"}]}` {
		t.Fatalf("public: %s", p)
	}
	if b, _ := json.Marshal(open); bytes.Contains(b, []byte("seed")) {
		t.Fatal("the answer to unlock holds a private key")
	}
	if a := k.ask("sign", map[string]any{"key": "k1", "box": "box-a", "algorithm": "ssh-ed25519", "data": base64.StdEncoding.EncodeToString(data)}); a["ok"] != true {
		t.Fatalf("sign after reopening: %v", a)
	}

	// A new password; then the old one is wrong and the new one right.
	if a := k.password(pwChange, []byte("short")); a["error"] != "password-too-short" {
		t.Fatal(a)
	}
	if a := k.password(pwChange, []byte("another long password")); a["ok"] != true || a["backup"] != "written" {
		t.Fatalf("change: %v", a)
	}
	_ = k.p.in.Close()
	k.p.exit(t)
	k = startKeys(t, file)
	if a := k.password(pwUnlock, []byte(goodPassword)); a["error"] != "wrong-password" {
		t.Fatalf("the old password: %v", a)
	}
}

// A wrong password is said plainly and makes the next try wait: one second, then two; a try during the wait
// is not even looked at; the right password after the wait opens the list.
func TestAWrongPasswordMakesTheNextTryWait(t *testing.T) {
	file := filepath.Join(t.TempDir(), "list.berth")
	k := startKeys(t, file)
	k.password(pwCreate, []byte(goodPassword))
	_ = k.p.in.Close()
	k.p.exit(t)

	k = startKeys(t, file)
	if a := k.password(pwUnlock, []byte("not the password!")); a["error"] != "wrong-password" || a["retryAfterMs"] != float64(1000) {
		t.Fatalf("first wrong: %v", a)
	}
	if a := k.password(pwUnlock, []byte(goodPassword)); a["error"] != "wait" || a["retryAfterMs"].(float64) <= 0 {
		t.Fatalf("the right password during the wait was looked at: %v", a)
	}
	if s := k.ask("status", nil); s["retryAfterMs"] == nil || s["unlocked"] != false {
		t.Fatalf("status during the wait: %v", s)
	}
	time.Sleep(1100 * time.Millisecond)
	if a := k.password(pwUnlock, []byte("still not the password")); a["error"] != "wrong-password" || a["retryAfterMs"] != float64(2000) {
		t.Fatalf("second wrong: %v", a)
	}
	time.Sleep(2100 * time.Millisecond)
	if a := k.password(pwUnlock, []byte(goodPassword)); a["ok"] != true {
		t.Fatalf("the right password after the wait: %v", a)
	}
}

// A damaged list is said as damaged, is not replaced, and a backup restores it.
func TestADamagedListAndARestore(t *testing.T) {
	dir := t.TempDir()
	file, backups := filepath.Join(dir, "list.berth"), filepath.Join(dir, "backups")
	_ = os.Mkdir(backups, 0o700)
	k := startKeys(t, file)
	k.password(pwCreate, []byte(goodPassword))
	k.ask("setBackupDir", map[string]any{"dir": backups})
	made := k.ask("newKey", map[string]any{"name": "k1", "box": "box-a", "user": "demo"})
	_ = k.p.in.Close()
	k.p.exit(t)

	good, _ := os.ReadFile(file)
	bad := bytes.Clone(good)
	bad[len(bad)-3] ^= 0x40
	_ = os.WriteFile(file, bad, 0o600)

	k = startKeys(t, file)
	if a := k.password(pwUnlock, []byte(goodPassword)); a["error"] != "damaged" || a["hasPrevious"] != true {
		t.Fatalf("a damaged list: %v", a)
	}
	if after, _ := os.ReadFile(file); !bytes.Equal(after, bad) {
		t.Fatal("a damaged list was replaced by itself")
	}
	backup := filepath.Join(backups, "Berth list backup.berth")
	rest := append(binary.BigEndian.AppendUint32(nil, uint32(len(backup))), backup...)
	if a := k.password(pwRestore, append(bytes.Clone(rest), "not the password!"...)); a["error"] != "wrong-password" {
		t.Fatalf("restore with a wrong password: %v", a)
	}
	time.Sleep(1100 * time.Millisecond)
	a := k.password(pwRestore, append(rest, goodPassword...))
	list, _ := a["keys"].([]any)
	if a["ok"] != true || len(list) != 1 || list[0].(map[string]any)["publicKey"] != made["publicKey"] {
		t.Fatalf("restore: %v", a)
	}
	_ = k.p.in.Close()
	k.p.exit(t)
	k = startKeys(t, file)
	if a := k.password(pwUnlock, []byte(goodPassword)); a["ok"] != true {
		t.Fatalf("the restored list did not become the list: %v", a)
	}
}

func TestTheKeyProcessAnswersItsHeartbeatAndTakesNoOtherFrames(t *testing.T) {
	k := startKeys(t, filepath.Join(t.TempDir(), "list.berth"))
	k.p.send(t, frame.TypePing, []byte("12345678"))
	if f := k.p.read(t); f.Type != frame.TypePong || string(f.Body) != "12345678" {
		t.Fatalf("%#x %s", f.Type, f.Body)
	}
	k.p.send(t, frame.TypeInput, []byte("ls"))
	if f := k.p.read(t); f.Type != frame.TypeFatal {
		t.Fatalf("%#x %s", f.Type, f.Body)
	}
	if code := k.p.exit(t); code != exitBadFrame {
		t.Fatalf("exit %d", code)
	}

	p := start(t)
	p.send(t, frame.TypeAim, []byte(`{"v":1,"role":"keys","file":"relative.berth"}`))
	if f := p.read(t); f.Type != frame.TypeFatal {
		t.Fatalf("a key process with no full path for the list: %#x %s", f.Type, f.Body)
	}
}

// Main beats once a second, and a stalled main cannot report itself: this process is the one place that can
// see main stop. It counts a silence longer than five seconds and keeps the longest.
func TestItTimesMainsBeat(t *testing.T) {
	k := startKeys(t, filepath.Join(t.TempDir(), "list.berth"))
	if s := k.ask("status", nil); s["mainStalls"] != float64(0) || s["mainLongestStallMs"] != float64(0) {
		t.Fatalf("before any silence: %v", s)
	}
	// Words close together are no silence, however many.
	for i := 0; i < 5; i++ {
		k.ask("status", nil)
	}
	if s := k.ask("status", nil); s["mainStalls"] != float64(0) {
		t.Fatalf("words close together were counted as a silence: %v", s)
	}
	// A gap longer than five seconds is one, and its length is kept.
	time.Sleep(mainQuietAfter + 300*time.Millisecond)
	s := k.ask("status", nil)
	if s["mainStalls"] != float64(1) {
		t.Fatalf("a silence of more than five seconds was not counted: %v", s)
	}
	ms, _ := s["mainLongestStallMs"].(float64)
	if ms < float64(mainQuietAfter/time.Millisecond) || ms > float64(mainQuietAfter/time.Millisecond)+3000 {
		t.Fatalf("the silence was measured as %v ms", ms)
	}
	// A second, shorter silence is counted, and does not shorten the longest.
	k.ask("status", nil)
	if s := k.ask("status", nil); s["mainStalls"] != float64(1) || s["mainLongestStallMs"] != ms {
		t.Fatalf("after a short gap: %v", s)
	}
}
