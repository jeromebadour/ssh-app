package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
)

func newKey(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func line(k ssh.PublicKey) string { return strings.TrimSpace(string(ssh.MarshalAuthorizedKey(k))) }

// rig is a test standing in for main and for the key process, with a box for the engine to reach.
type rig struct {
	t     *testing.T
	p     *proc
	box   *hostile.Box
	proxy *faultproxy.Proxy
	user  ssh.Signer

	mu       sync.Mutex
	frames   []frame.Frame
	arrived  chan struct{}
	signWith func(req map[string]any) map[string]any // nil: sign honestly
	noAck    bool
	taken    uint64
	asked    []map[string]any
}

type rigOpt struct {
	box      func(*hostile.Config)
	pin      ssh.PublicKey
	folder   string
	signWith func(req map[string]any) map[string]any
	noAck    bool
}

func newRig(t *testing.T, opt rigOpt) *rig {
	t.Helper()
	host, user := newKey(t), newKey(t)
	cfg := hostile.Config{HostSigner: host, Accept: user.PublicKey(), Sessions: true, Banner: "Welcome to demo-eu\n"}
	if opt.box != nil {
		opt.box(&cfg)
	}
	box, err := hostile.Start(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(box.Close)
	proxy, err := faultproxy.Listen(box.Addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)
	pin := host.PublicKey()
	if opt.pin != nil {
		pin = opt.pin
	}
	r := &rig{t: t, p: start(t), box: box, proxy: proxy, user: user, arrived: make(chan struct{}, 1), signWith: opt.signWith, noAck: opt.noAck}
	aim, _ := json.Marshal(map[string]any{"v": 1, "tab": "3", "stub": false,
		"box":   map[string]any{"addr": proxy.Addr(), "user": "demo", "hostKey": line(pin), "key": "k1", "publicKey": line(user.PublicKey())},
		"shell": map[string]any{"folder": opt.folder, "term": "xterm-256color", "cols": 120, "rows": 40}})
	r.p.send(t, frame.TypeAim, aim)
	go r.pump()
	return r
}

// pump reads every frame the engine sends, answers signing requests as the key process would, and takes
// output as a tab would.
func (r *rig) pump() {
	for {
		f, err := frame.Read(r.p.out)
		if err != nil {
			return
		}
		switch f.Type {
		case frame.TypeSignRequest:
			var req map[string]any
			_ = json.Unmarshal(f.Body, &req)
			r.mu.Lock()
			r.asked = append(r.asked, req)
			r.mu.Unlock()
			var rep map[string]any
			if r.signWith != nil {
				rep = r.signWith(req)
			} else {
				rep = signHonestly(r.user, req)
			}
			body, _ := json.Marshal(rep)
			buf, _ := frame.Append(nil, frame.TypeSignReply, body)
			_, _ = r.p.in.Write(buf)
		case frame.TypeOutput:
			r.mu.Lock()
			r.taken += uint64(len(f.Body))
			n := r.taken
			noAck := r.noAck
			r.mu.Unlock()
			if !noAck {
				r.ack(n)
			}
		}
		r.mu.Lock()
		r.frames = append(r.frames, f)
		r.mu.Unlock()
		select {
		case r.arrived <- struct{}{}:
		default:
		}
	}
}

func (r *rig) ack(n uint64) {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], n)
	buf, _ := frame.Append(nil, frame.TypeAck, b[:])
	_, _ = r.p.in.Write(buf)
}

func signHonestly(key ssh.Signer, req map[string]any) map[string]any {
	data, _ := base64.StdEncoding.DecodeString(req["data"].(string))
	sig, err := key.Sign(rand.Reader, data)
	if err != nil {
		return map[string]any{"id": req["id"], "error": err.Error()}
	}
	return map[string]any{"id": req["id"], "signature": base64.StdEncoding.EncodeToString(ssh.Marshal(sig))}
}

func (r *rig) all() []frame.Frame {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]frame.Frame(nil), r.frames...)
}

// wait returns once ok says the frames so far are what the test waits for.
func (r *rig) wait(what string, ok func([]frame.Frame) bool) []frame.Frame {
	r.t.Helper()
	deadline := time.After(10 * time.Second)
	for {
		if fs := r.all(); ok(fs) {
			return fs
		}
		select {
		case <-r.arrived:
		case <-time.After(20 * time.Millisecond):
		case <-deadline:
			r.t.Fatalf("waited 10 s for %s; got: %s", what, describe(r.all()))
		}
	}
}

func describe(fs []frame.Frame) string {
	var b strings.Builder
	for _, f := range fs {
		if f.Type == frame.TypeOutput {
			b.WriteString(" Output(" + itoa(len(f.Body)) + ")")
		} else {
			b.WriteString(" " + itoa(int(f.Type)) + ":" + string(f.Body))
		}
	}
	return b.String()
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

func states(fs []frame.Frame) []map[string]any {
	var out []map[string]any
	for _, f := range fs {
		if f.Type == frame.TypeState {
			var v map[string]any
			_ = json.Unmarshal(f.Body, &v)
			out = append(out, v)
		}
	}
	return out
}

func lastState(fs []frame.Frame) map[string]any {
	s := states(fs)
	if len(s) == 0 {
		return map[string]any{}
	}
	return s[len(s)-1]
}

func output(fs []frame.Frame) []byte {
	var b []byte
	for _, f := range fs {
		if f.Type == frame.TypeOutput {
			b = append(b, f.Body...)
		}
	}
	return b
}

func has(fs []frame.Frame, typ byte) *frame.Frame {
	for i := range fs {
		if fs[i].Type == typ {
			return &fs[i]
		}
	}
	return nil
}

func isUp(fs []frame.Frame) bool    { return lastState(fs)["state"] == "up" }
func isEnded(fs []frame.Frame) bool { return lastState(fs)["state"] == "ended" }

// The whole life of a tab's engine: every phase said, the box's sign-in text passed on, the shell opened as a
// place, typed bytes out and output back, a resize, a round trip measured, the shell's end and its status.
func TestATabsWholeLife(t *testing.T) {
	r := newRig(t, rigOpt{folder: "/srv/app"})
	fs := r.wait("the link to be up", isUp)
	var order []string
	for _, s := range states(fs) {
		order = append(order, s["state"].(string))
	}
	if strings.Join(order, ",") != "connecting,key-exchange,signing-in,up" {
		t.Fatalf("states: %v", order)
	}
	up := lastState(fs)
	if up["keyExchange"] != "mlkem768x25519-sha256" || up["cipher"] != "aes256-gcm@openssh.com" || up["identityAlgorithm"] != "ssh-ed25519" || up["postQuantum"] != true {
		t.Fatalf("up: %v", up)
	}
	if b := has(fs, frame.TypeBanner); b == nil || string(b.Body) != "Welcome to demo-eu\n" {
		t.Fatalf("banner: %v", b)
	}
	if h := fs[0]; h.Type != frame.TypeHello || !bytes.Contains(h.Body, []byte(`"stub":false`)) {
		t.Fatalf("hello: %s", h.Body)
	}

	r.p.send(t, frame.TypeInput, []byte("ls -la\r"))
	r.wait("the echo", func(fs []frame.Frame) bool { return string(output(fs)) == "ls -la\r" })
	r.p.send(t, frame.TypeResize, []byte(`{"cols":132,"rows":43}`))
	fs = r.wait("a round trip", func(fs []frame.Frame) bool { return has(fs, frame.TypePulse) != nil })
	var pulse map[string]any
	_ = json.Unmarshal(has(fs, frame.TypePulse).Body, &pulse)
	if pulse["silent"] != false || pulse["rttMs"] == nil {
		t.Fatalf("pulse: %v", pulse)
	}

	r.p.send(t, frame.TypeInput, []byte("exit\n"))
	fs = r.wait("the end", isEnded)
	var exit map[string]any
	if e := has(fs, frame.TypeExit); e == nil || json.Unmarshal(e.Body, &exit) != nil || exit["status"] != float64(7) {
		t.Fatalf("exit: %v", exit)
	}
	if end := lastState(fs); end["cause"] != "shell-exited" {
		t.Fatalf("ended: %v", end)
	}
	if code := r.p.exit(t); code != exitOK {
		t.Fatalf("exit code %d", code)
	}

	got := r.box.Sessions()
	if len(got) != 1 || strings.Join(got[0].Asked, ",") != "pty-req,exec,window-change" || got[0].Command != `cd -- '/srv/app' && exec "$SHELL" -l` ||
		got[0].Cols != 120 || got[0].Rows != 40 || len(got[0].Resizes) != 1 || got[0].Resizes[0] != [2]uint32{132, 43} {
		t.Fatalf("the box was asked: %+v", got)
	}
}

// What the key process is asked to sign: named key, named algorithm, and data that begins with a session
// value of exactly 32 bytes (the key process checks the same, plan B1). Asked once.
func TestWhatIsAskedOfTheKeyProcess(t *testing.T) {
	r := newRig(t, rigOpt{})
	r.wait("the link to be up", isUp)
	r.mu.Lock()
	asked := r.asked
	r.mu.Unlock()
	if len(asked) != 1 {
		t.Fatalf("asked to sign %d times", len(asked))
	}
	q := asked[0]
	data, _ := base64.StdEncoding.DecodeString(q["data"].(string))
	if q["key"] != "k1" || q["algorithm"] != "ssh-ed25519" || len(data) < 36 || binary.BigEndian.Uint32(data) != 32 {
		t.Fatalf("asked: %v (%d bytes)", q, len(data))
	}
	if !bytes.Contains(data, []byte("demo")) || !bytes.Contains(data, []byte("ssh-connection")) || !bytes.Contains(data, []byte("publickey")) {
		t.Fatal("the data to sign is not a sign-in request for this user")
	}
}

func TestSigningThatGoesWrongIsSaid(t *testing.T) {
	stranger := newKey(t)
	for name, signWith := range map[string]func(map[string]any) map[string]any{
		"the key process refuses": func(q map[string]any) map[string]any {
			return map[string]any{"id": q["id"], "error": "locked"}
		},
		"a signature by another key": func(q map[string]any) map[string]any { return signHonestly(stranger, q) },
		"not a signature at all": func(q map[string]any) map[string]any {
			return map[string]any{"id": q["id"], "signature": "AAAA"}
		},
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, rigOpt{signWith: signWith})
			end := lastState(r.wait("the end", isEnded))
			if end["cause"] != "no-signature" || end["phase"] != "signing-in" {
				t.Fatalf("ended: %v", end)
			}
			if code := r.p.exit(t); code != exitOK {
				t.Fatalf("exit code %d", code)
			}
		})
	}
}

// A box that is not the pinned one: said with the key it showed, and the key process is never asked anything.
func TestASwappedBoxIsNeverSignedFor(t *testing.T) {
	r := newRig(t, rigOpt{pin: newKey(t).PublicKey()})
	end := lastState(r.wait("the end", isEnded))
	got, _ := end["got"].(string)
	fp, _ := end["gotFingerprint"].(string)
	if end["cause"] != "identity-changed" || !strings.HasPrefix(got, "ssh-ed25519 ") || !strings.HasPrefix(fp, "SHA256:") {
		t.Fatalf("ended: %v", end)
	}
	r.mu.Lock()
	n := len(r.asked)
	r.mu.Unlock()
	if n != 0 {
		t.Fatal("the key process was asked to sign for a box that is not the pinned one")
	}
}

// The tab falls behind: the engine stops taking from the box at the credit limit, says after a second that
// the box is waiting on the window, still answers its heartbeat, and loses nothing when the tab catches up.
func TestOutputWaitsForTheTabAndLosesNothing(t *testing.T) {
	r := newRig(t, rigOpt{noAck: true})
	r.wait("the link to be up", isUp)
	data := make([]byte, 2<<20)
	_, _ = rand.Read(data)
	go func() {
		for at := 0; at < len(data); at += 16 * 1024 {
			buf, _ := frame.Append(nil, frame.TypeInput, data[at:at+16*1024])
			_, _ = r.p.in.Write(buf)
		}
	}()
	isNotice := func(on bool) func([]frame.Frame) bool {
		return func(fs []frame.Frame) bool {
			for _, f := range fs {
				if f.Type == frame.TypeNotice && bytes.Contains(f.Body, []byte("waiting-on-window")) && bytes.Contains(f.Body, []byte(map[bool]string{true: `"on":true`, false: `"on":false`}[on])) {
					return true
				}
			}
			return false
		}
	}
	fs := r.wait("the tab to be told the box is waiting", isNotice(true))
	if n := len(output(fs)); n < creditLimit || n > creditLimit+outputChunk {
		t.Fatalf("with nothing taken, %d bytes were sent; the limit is %d", n, creditLimit)
	}
	r.p.send(t, frame.TypePing, []byte("still-there"))
	r.wait("the heartbeat's answer while held", func(fs []frame.Frame) bool {
		for _, f := range fs {
			if f.Type == frame.TypePong && string(f.Body) == "still-there" {
				return true
			}
		}
		return false
	})

	r.mu.Lock()
	r.noAck = false
	n := r.taken
	r.mu.Unlock()
	r.ack(n)
	fs = r.wait("all of it", func(fs []frame.Frame) bool { return len(output(fs)) >= len(data) })
	if !bytes.Equal(output(fs), data) {
		t.Fatal("2 MiB did not come back the same after the tab caught up")
	}
	r.wait("the tab to be told the wait is over", isNotice(false))
}

func TestALinkThatIsResetIsSaidAsThat(t *testing.T) {
	r := newRig(t, rigOpt{})
	r.wait("the link to be up", isUp)
	r.proxy.Reset()
	if end := lastState(r.wait("the end", isEnded)); end["cause"] != "reset" {
		t.Fatalf("ended: %v", end)
	}
	if code := r.p.exit(t); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
}

// A silent link is said and kept; the engine does not end, and typed bytes sent meanwhile arrive when it is back.
func TestASilentLinkIsKept(t *testing.T) {
	r := newRig(t, rigOpt{})
	r.wait("the first round trip", func(fs []frame.Frame) bool { return has(fs, frame.TypePulse) != nil })
	r.proxy.Set(faultproxy.Faults{Hold: true})
	r.p.send(t, frame.TypeInput, []byte("typed in the dark"))
	time.Sleep(1500 * time.Millisecond)
	if fs := r.all(); isEnded(fs) || len(output(fs)) != 0 {
		t.Fatalf("during the silence: %s", describe(fs))
	}
	r.proxy.Set(faultproxy.Faults{})
	r.wait("the typed bytes after the silence", func(fs []frame.Frame) bool { return string(output(fs)) == "typed in the dark" })
}

func TestTheParentGoneEndsTheSession(t *testing.T) {
	r := newRig(t, rigOpt{})
	r.wait("the link to be up", isUp)
	_ = r.p.in.Close()
	if code := r.p.exit(t); code != exitOK {
		t.Fatalf("exit code %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for r.proxy.Open() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the engine is gone and its connection is still open")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestFramesThatMakeNoSenseEndIt(t *testing.T) {
	for name, send := range map[string]func(r *rig){
		"a signature nobody asked for": func(r *rig) { r.p.send(r.t, frame.TypeSignReply, []byte(`{"id":99,"signature":"AAAA"}`)) },
		"an Ack for bytes never sent":  func(r *rig) { r.ack(1 << 40) },
		"a Resize to nothing":          func(r *rig) { r.p.send(r.t, frame.TypeResize, []byte(`{"cols":0,"rows":10}`)) },
		"a second Aim":                 func(r *rig) { r.p.send(r.t, frame.TypeAim, []byte(`{"v":1,"tab":"9","stub":true}`)) },
	} {
		t.Run(name, func(t *testing.T) {
			r := newRig(t, rigOpt{})
			r.wait("the link to be up", isUp)
			send(r)
			// Read what it says before asking how it exited: waiting for the exit closes the pipe it speaks on.
			r.wait("it to say why", func(fs []frame.Frame) bool { return has(fs, frame.TypeFatal) != nil })
			if code := r.p.exit(t); code != exitBadFrame {
				t.Fatalf("exit code %d", code)
			}
		})
	}
}

func TestAnAimWithNoUsableBoxIsRefused(t *testing.T) {
	for _, aim := range []string{
		`{"v":1,"tab":"3","stub":false}`,
		`{"v":1,"tab":"3","stub":false,"box":{"addr":"127.0.0.1:1","user":"demo","hostKey":"not a key","key":"k1","publicKey":"nor this"}}`,
	} {
		p := start(t)
		p.send(t, frame.TypeAim, []byte(aim))
		p.read(t) // Hello
		if f := p.read(t); f.Type != frame.TypeFatal {
			t.Fatalf("got %#x %s", f.Type, f.Body)
		}
		if code := p.exit(t); code != exitNoAim {
			t.Fatalf("exit code %d", code)
		}
	}
}
