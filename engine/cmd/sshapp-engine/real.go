package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/frame"
	"sshapp/engine/internal/link"
)

// The real engine: one SSH link to the one box it was aimed at, one shell on it, and the frames that carry
// both to main. It lives for one link: when the link or the shell ends it says exactly how and exits; a new
// session is a new engine. It holds no key: every signature is asked for with a SignRequest frame.

const (
	creditLimit   = 512 * 1024      // Output bytes the tab may have not yet taken (plan B8)
	outputChunk   = 32 * 1024       // the most one Output frame carries
	inputLimit    = 8 * 1024 * 1024 // typed bytes that may wait for the box
	waitingAfter  = time.Second     // the box held up by the window this long: the tab says so
	signWait      = 30 * time.Second
	keepaliveGap  = 5 * time.Second
	keepaliveLate = 2 * time.Second
)

type boxAim struct {
	Addr      string `json:"addr"`
	User      string `json:"user"`
	HostKey   string `json:"hostKey"`   // the pinned identity, as one authorized-keys line
	Key       string `json:"key"`       // the name the key process knows this box's key by
	PublicKey string `json:"publicKey"` // that key's public half
}

type shellAim struct {
	Folder string `json:"folder"`
	Term   string `json:"term"`
	Cols   int    `json:"cols"`
	Rows   int    `json:"rows"`
}

type real struct {
	o *out

	mu       sync.Mutex
	changed  *sync.Cond
	pending  map[uint64]chan signReply
	nextSign uint64
	shell    *link.Shell
	size     [2]int // the last size asked for, kept until there is a shell
	sent     uint64 // Output bytes sent
	acked    uint64 // Output bytes the tab says it took
	input    [][]byte
	inputLen int
	dropped  int
	gone     bool
}

type signReply struct {
	ID        uint64 `json:"id"`
	Signature string `json:"signature"`
	Error     string `json:"error"`
}

func (r *real) state(v map[string]any) {
	body, _ := json.Marshal(v)
	r.o.send(frame.TypeState, body)
}

func (r *real) ended(e *link.Error) { r.state(endedState(e)) }

// endedState is how an end is said to main: the one cause, the phase it happened in, and what belongs to it.
func endedState(e *link.Error) map[string]any {
	v := map[string]any{"state": "ended", "cause": string(e.Cause), "phase": string(e.Phase)}
	if e.What != "" {
		v["what"], v["ours"], v["box"] = e.What, e.Ours, e.Box
	}
	if e.Got != nil {
		v["got"] = strings.TrimSpace(string(ssh.MarshalAuthorizedKey(e.Got)))
		v["gotFingerprint"] = ssh.FingerprintSHA256(e.Got)
	}
	if e.Err != nil {
		v["detail"] = e.Err.Error()
	}
	return v
}

// remoteSigner asks the key process, through main, for each signature. It names the algorithm, so an RSA key
// is never used with SHA-1.
type remoteSigner struct {
	r    *real
	key  string
	pub  ssh.PublicKey
	algs []string
}

func (s *remoteSigner) PublicKey() ssh.PublicKey { return s.pub }
func (s *remoteSigner) Algorithms() []string     { return s.algs }
func (s *remoteSigner) Sign(rnd io.Reader, data []byte) (*ssh.Signature, error) {
	return s.SignWithAlgorithm(rnd, data, s.algs[0])
}

func (s *remoteSigner) SignWithAlgorithm(_ io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	ok := false
	for _, a := range s.algs {
		ok = ok || a == algorithm
	}
	if !ok {
		return nil, errors.New("this key is not used with " + algorithm)
	}
	r := s.r
	r.mu.Lock()
	r.nextSign++
	id := r.nextSign
	answer := make(chan signReply, 1)
	r.pending[id] = answer
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.pending, id); r.mu.Unlock() }()

	body, _ := json.Marshal(map[string]any{"id": id, "key": s.key, "algorithm": algorithm, "data": base64.StdEncoding.EncodeToString(data)})
	r.o.send(frame.TypeSignRequest, body)
	select {
	case rep := <-answer:
		if rep.Error != "" {
			return nil, errors.New("the key process refused: " + rep.Error)
		}
		raw, err := base64.StdEncoding.DecodeString(rep.Signature)
		if err != nil {
			return nil, errors.New("the signature could not be read")
		}
		sig := new(ssh.Signature)
		if err := ssh.Unmarshal(raw, sig); err != nil || len(sig.Rest) != 0 || sig.Format != algorithm {
			return nil, errors.New("the signature is not of the kind asked for")
		}
		// Checked here before it goes to the box: a wrong signature is our fault to report, not the box's refusal.
		if err := s.pub.Verify(data, sig); err != nil {
			return nil, errors.New("the signature does not match the key")
		}
		return sig, nil
	case <-time.After(signWait):
		return nil, errors.New("no signature came")
	}
}

func algorithmsOf(pub ssh.PublicKey) []string {
	switch pub.Type() {
	case ssh.KeyAlgoED25519:
		return []string{ssh.KeyAlgoED25519}
	case ssh.KeyAlgoRSA:
		return []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256}
	case ssh.KeyAlgoECDSA256:
		return []string{ssh.KeyAlgoECDSA256}
	case ssh.KeyAlgoECDSA384:
		return []string{ssh.KeyAlgoECDSA384}
	case ssh.KeyAlgoECDSA521:
		return []string{ssh.KeyAlgoECDSA521}
	}
	return nil
}

// runReal is the engine's life after Aim. frames delivers everything main sends; it is closed when main is gone.
func runReal(o *out, frames <-chan frame.Frame, box boxAim, sh shellAim) int {
	r := &real{o: o, pending: map[uint64]chan signReply{}, size: [2]int{sh.Cols, sh.Rows}}
	r.changed = sync.NewCond(&r.mu)

	hostKey, _, _, _, err := ssh.ParseAuthorizedKey([]byte(box.HostKey))
	if err != nil {
		o.fatal(exitNoAim, "Aim holds no readable pinned identity")
	}
	pub, _, _, _, err := ssh.ParseAuthorizedKey([]byte(box.PublicKey))
	if err != nil || algorithmsOf(pub) == nil || box.Key == "" {
		o.fatal(exitNoAim, "Aim holds no usable key for the sign-in")
	}
	signer := &remoteSigner{r: r, key: box.Key, pub: pub, algs: algorithmsOf(pub)}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go r.fromMain(frames, cancel)

	l, err := link.Dial(ctx, link.Target{Addr: box.Addr, User: box.User, HostKey: hostKey}, signer, link.Options{
		OnPhase: func(p link.Phase) {
			if p != link.Up {
				r.state(map[string]any{"state": string(p)})
			}
		},
		OnBanner: func(msg string) { o.send(frame.TypeBanner, []byte(msg)) },
	})
	if err != nil {
		var e *link.Error
		if !errors.As(err, &e) {
			e = &link.Error{Cause: link.Protocol, Phase: link.Connecting, Err: err}
		}
		r.ended(e)
		return exitOK
	}
	defer l.Close()
	d := l.Details()
	r.state(map[string]any{"state": "up", "keyExchange": d.KeyExchange, "cipher": d.Cipher, "identityAlgorithm": d.IdentityAlgorithm, "postQuantum": d.PostQuantum})

	l.Watch(keepaliveGap, keepaliveLate, func(p link.Pulse) {
		v := map[string]any{"silent": p.Silent}
		if p.Silent {
			v["sinceMs"] = p.Since.UnixMilli()
		} else {
			v["rttMs"] = p.RoundTrip.Milliseconds()
		}
		body, _ := json.Marshal(v)
		o.send(frame.TypePulse, body)
	})

	r.mu.Lock()
	cols, rows := r.size[0], r.size[1]
	r.mu.Unlock()
	shell, err := l.OpenShell(link.ShellOptions{Folder: sh.Folder, Term: sh.Term, Cols: cols, Rows: rows})
	if err != nil {
		select { // no shell because the link went meanwhile: that is the link's end, said as such
		case <-l.Done():
			r.ended(l.End())
			return exitOK
		case <-time.After(200 * time.Millisecond):
		}
		r.state(map[string]any{"state": "ended", "cause": "no-shell", "phase": "up", "detail": err.Error(), "folderName": errors.Is(err, link.ErrFolderName)})
		return exitOK
	}
	r.mu.Lock()
	r.shell = shell
	if r.size != [2]int{cols, rows} { // a resize arrived while the shell was opening
		_ = shell.Resize(r.size[0], r.size[1])
	}
	r.mu.Unlock()
	r.changed.Broadcast()

	go r.typeInto(shell)
	outputDone := make(chan struct{})
	go func() { r.printFrom(shell); close(outputDone) }()

	select {
	case <-shell.Exited():
		<-outputDone // everything the shell printed has been sent
		v := map[string]any{}
		if code, ok := shell.ExitStatus(); ok {
			v["status"] = code
		}
		body, _ := json.Marshal(v)
		o.send(frame.TypeExit, body)
		select { // a shell that ended because the link went is the link's end, said as such
		case <-l.Done():
			r.ended(l.End())
		case <-time.After(200 * time.Millisecond):
			r.state(map[string]any{"state": "ended", "cause": "shell-exited", "phase": "up"})
		}
	case <-l.Done():
		r.ended(l.End())
	case <-ctx.Done(): // main is gone
	}
	return exitOK
}

// fromMain handles every frame main sends, and never waits on the box: typed bytes are queued, not written here.
func (r *real) fromMain(frames <-chan frame.Frame, parentGone func()) {
	for f := range frames {
		switch f.Type {
		case frame.TypePing:
			r.o.send(frame.TypePong, f.Body)
		case frame.TypeInput:
			r.mu.Lock()
			if r.inputLen+len(f.Body) > inputLimit {
				r.dropped += len(f.Body)
				n := r.dropped
				r.mu.Unlock()
				body, _ := json.Marshal(map[string]any{"notice": "typed-bytes-dropped", "bytes": n})
				r.o.send(frame.TypeNotice, body)
				continue
			}
			r.input = append(r.input, f.Body)
			r.inputLen += len(f.Body)
			r.mu.Unlock()
			r.changed.Broadcast()
		case frame.TypeResize:
			var v struct{ Cols, Rows int }
			if json.Unmarshal(f.Body, &v) != nil || v.Cols <= 0 || v.Rows <= 0 || v.Cols > 2000 || v.Rows > 2000 {
				r.o.fatal(exitBadFrame, "Resize could not be read")
			}
			r.mu.Lock()
			r.size = [2]int{v.Cols, v.Rows}
			if r.shell != nil {
				_ = r.shell.Resize(v.Cols, v.Rows)
			}
			r.mu.Unlock()
		case frame.TypeAck:
			if len(f.Body) != 8 {
				r.o.fatal(exitBadFrame, "Ack is not 8 bytes")
			}
			n := binary.BigEndian.Uint64(f.Body)
			r.mu.Lock()
			if n > r.sent || n < r.acked {
				r.mu.Unlock()
				r.o.fatal(exitBadFrame, "Ack counts bytes that were never sent")
			}
			r.acked = n
			r.mu.Unlock()
			r.changed.Broadcast()
		case frame.TypeSignReply:
			var rep signReply
			if json.Unmarshal(f.Body, &rep) != nil {
				r.o.fatal(exitBadFrame, "SignReply could not be read")
			}
			r.mu.Lock()
			ch := r.pending[rep.ID]
			delete(r.pending, rep.ID)
			r.mu.Unlock()
			if ch == nil {
				r.o.fatal(exitBadFrame, "a SignReply nobody asked for")
			}
			ch <- rep
		case frame.TypeAim:
			r.o.fatal(exitBadFrame, "an engine is aimed once")
		default:
			r.o.fatal(exitBadFrame, "unknown frame type")
		}
	}
	r.mu.Lock()
	r.gone = true
	r.mu.Unlock()
	r.changed.Broadcast()
	parentGone()
}

// typeInto writes queued typed bytes to the shell, in order, exactly.
func (r *real) typeInto(shell *link.Shell) {
	for {
		r.mu.Lock()
		for len(r.input) == 0 && !r.gone {
			r.changed.Wait()
		}
		if r.gone {
			r.mu.Unlock()
			return
		}
		next := r.input[0]
		r.input = r.input[1:]
		r.mu.Unlock()
		_, err := shell.Write(next)
		r.mu.Lock()
		r.inputLen -= len(next)
		r.mu.Unlock()
		if err != nil {
			return
		}
	}
}

// printFrom sends what the shell prints, never more than creditLimit ahead of what the tab has taken. While
// the tab is behind, nothing more is read from the box: the box waits, and after a second the tab is told so.
func (r *real) printFrom(shell *link.Shell) {
	buf := make([]byte, outputChunk)
	for {
		r.mu.Lock()
		var told *time.Timer
		for r.sent-r.acked >= creditLimit && !r.gone {
			if told == nil {
				told = time.AfterFunc(waitingAfter, func() {
					r.mu.Lock()
					still := r.sent-r.acked >= creditLimit && !r.gone
					r.mu.Unlock()
					if still {
						r.o.send(frame.TypeNotice, []byte(`{"notice":"waiting-on-window","on":true}`))
					}
				})
			}
			r.changed.Wait()
		}
		gone := r.gone
		r.mu.Unlock()
		if gone {
			return
		}
		if told != nil && !told.Stop() { // the tab was told the box is waiting: tell it that is over
			r.o.send(frame.TypeNotice, []byte(`{"notice":"waiting-on-window","on":false}`))
		}
		n, err := shell.Read(buf)
		if n > 0 {
			r.mu.Lock()
			r.sent += uint64(n)
			r.mu.Unlock()
			r.o.send(frame.TypeOutput, buf[:n])
		}
		if err != nil {
			return
		}
	}
}
