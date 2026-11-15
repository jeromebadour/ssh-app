package link

import (
	"bufio"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"sshapp/engine/internal/lab/faultproxy"
)

// The link against real OpenSSH servers (plan B9): the newest, and 8.9, the oldest the app supports. They run
// in containers that scripts/lab-openssh.sh starts, in CI only; LAB_OPENSSH is the folder that script wrote.
// Without it these tests are skipped, except when LAB_OPENSSH_REQUIRED is set: then a missing lab is a failure.

type realBox struct {
	name, honest, rsaOnly, weakCipher, kex, version string
}

type realLab struct {
	boxes   []realBox
	user    ssh.Signer
	hostEd  ssh.PublicKey
	hostRSA ssh.PublicKey
}

func openLab(t *testing.T) *realLab {
	t.Helper()
	dir := os.Getenv("LAB_OPENSSH")
	if dir == "" {
		if os.Getenv("LAB_OPENSSH_REQUIRED") != "" {
			t.Fatal("LAB_OPENSSH_REQUIRED is set but there is no lab (LAB_OPENSSH)")
		}
		t.Skip("no real OpenSSH servers here: this runs in CI (scripts/lab-openssh.sh)")
	}
	read := func(name string) []byte {
		b, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	pub := func(name string) ssh.PublicKey {
		k, _, _, _, err := ssh.ParseAuthorizedKey(read(name))
		if err != nil {
			t.Fatal(err)
		}
		return k
	}
	user, err := ssh.ParsePrivateKey(read("user"))
	if err != nil {
		t.Fatal(err)
	}
	lab := &realLab{user: user, hostEd: pub("host_ed.pub"), hostRSA: pub("host_rsa.pub")}
	sc := bufio.NewScanner(strings.NewReader(string(read("boxes"))))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 6 {
			t.Fatalf("a line of the lab's box list is not six words: %q", sc.Text())
		}
		lab.boxes = append(lab.boxes, realBox{f[0], f[1], f[2], f[3], f[4], f[5]})
	}
	if len(lab.boxes) < 2 {
		t.Fatalf("the lab has %d servers; it must have the oldest and the newest", len(lab.boxes))
	}
	return lab
}

// run starts a command on the box the plain SSH way and returns what it printed. The app itself never does
// this outside the plan's list; here it is how a test sees that a real shell is on the other end.
func run(t *testing.T, l *Link, cmd string, limit time.Duration) string {
	t.Helper()
	s, err := tryRun(l, cmd, limit)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func tryRun(l *Link, cmd string, limit time.Duration) (string, error) {
	ch, reqs, err := l.Conn().OpenChannel("session", nil)
	if err != nil {
		return "", err
	}
	defer ch.Close()
	go ssh.DiscardRequests(reqs)
	payload := make([]byte, 4+len(cmd))
	binary.BigEndian.PutUint32(payload, uint32(len(cmd)))
	copy(payload[4:], cmd)
	if ok, err := ch.SendRequest("exec", true, payload); err != nil || !ok {
		return "", fmt.Errorf("the box did not start %q: %v", cmd, err)
	}
	out := make(chan string, 1)
	go func() { b, _ := io.ReadAll(ch); out <- string(b) }()
	select {
	case s := <-out:
		return s, nil
	case <-time.After(limit):
		return "", fmt.Errorf("%q did not finish within %v", cmd, limit)
	}
}

func TestOpenSSH(t *testing.T) {
	lab := openLab(t)
	for _, box := range lab.boxes {
		t.Run(box.name+" "+box.version, func(t *testing.T) {
			honest := Target{Addr: box.honest, User: "demo", HostKey: lab.hostEd}

			t.Run("connects, agrees what the plan says, and a real shell answers", func(t *testing.T) {
				var banner string
				l, err := Dial(context.Background(), honest, lab.user, Options{OnBanner: func(m string) { banner = m }})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				d := l.Details()
				if d.KeyExchange != box.kex || d.Cipher != ssh.CipherAES256GCM || d.IdentityAlgorithm != ssh.KeyAlgoED25519 {
					t.Fatalf("agreed %+v; the key exchange must be %s", d, box.kex)
				}
				if got := run(t, l, "echo it is $(id -un)", 10*time.Second); got != "it is demo\n" {
					t.Fatalf("the shell said %q (banner %q)", got, banner)
				}
				t.Logf("agreed: %s, %s, %s", d.KeyExchange, d.Cipher, d.IdentityAlgorithm)
			})

			t.Run("another identity than the pinned one is a hard stop", func(t *testing.T) {
				user := &countingSigner{Signer: lab.user}
				wrong := honest
				wrong.HostKey = edKey(t).PublicKey()
				_, err := Dial(context.Background(), wrong, user, Options{})
				e, ok := err.(*Error)
				if !ok || e.Cause != IdentityChanged || e.Got == nil || string(e.Got.Marshal()) != string(lab.hostEd.Marshal()) {
					t.Fatalf("%v", err)
				}
				if user.n.Load() != 0 {
					t.Fatal("our key was used at a box that is not the pinned one")
				}
			})

			t.Run("a key the box does not know", func(t *testing.T) {
				_, err := Dial(context.Background(), honest, edKey(t), Options{})
				if e, ok := err.(*Error); !ok || e.Cause != SignInFailed {
					t.Fatalf("%v", err)
				}
			})

			t.Run("a user the box does not have", func(t *testing.T) {
				nobody := honest
				nobody.User = "nobody-here"
				_, err := Dial(context.Background(), nobody, lab.user, Options{})
				if e, ok := err.(*Error); !ok || e.Cause != SignInFailed {
					t.Fatalf("%v", err)
				}
			})

			t.Run("a box whose identity is an RSA key signs it with SHA-2", func(t *testing.T) {
				l, err := Dial(context.Background(), Target{Addr: box.rsaOnly, User: "demo", HostKey: lab.hostRSA}, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				if a := l.Details().IdentityAlgorithm; a != ssh.KeyAlgoRSASHA512 {
					t.Fatalf("identity signed with %s", a)
				}
			})

			t.Run("a box with only a cipher we refuse", func(t *testing.T) {
				_, err := Dial(context.Background(), Target{Addr: box.weakCipher, User: "demo", HostKey: lab.hostEd}, lab.user, Options{})
				e, ok := err.(*Error)
				if !ok || e.Cause != WeakOffer || e.What != "cipher" {
					t.Fatalf("%v", err)
				}
			})

			// A place opens in its folder, as the user's own login shell, with a real terminal of the size we
			// said; a quote in the folder's name is only part of the name; a resize reaches the terminal.
			t.Run("a place's shell: its folder, a terminal, a resize", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				folder := "/tmp/it's a $(place) `here`"
				run(t, l, "mkdir -p \"/tmp/it's a \\$(place) \\`here\\`\"", 10*time.Second)
				sh, err := l.OpenShell(ShellOptions{Folder: folder, Term: "xterm-256color", Cols: 100, Rows: 30})
				if err != nil {
					t.Fatal(err)
				}
				defer sh.Close()
				if err := sh.Resize(132, 43); err != nil {
					t.Fatal(err)
				}
				time.Sleep(300 * time.Millisecond)
				_, _ = sh.Write([]byte("echo \"in <$PWD> size <$(stty size)> term <$TERM> tty <$(tty | cut -c1-8)>\"; exit 3\n"))
				out := make(chan string, 1)
				go func() { b, _ := io.ReadAll(sh); out <- string(b) }()
				var got string
				select {
				case got = <-out:
				case <-time.After(15 * time.Second):
					t.Fatal("the shell did not finish")
				}
				want := "in <" + folder + "> size <43 132> term <xterm-256color> tty </dev/pts>"
				if !strings.Contains(got, want) {
					t.Fatalf("the shell printed %q; wanted a line with %q", got, want)
				}
				<-sh.Exited()
				if code, ok := sh.ExitStatus(); !ok || code != 3 {
					t.Fatalf("exit status %d %v", code, ok)
				}
			})

			t.Run("a folder that is not there: the shell does not start, and says so", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				sh, err := l.OpenShell(ShellOptions{Folder: "/tmp/not-there", Term: "xterm", Cols: 80, Rows: 24})
				if err != nil {
					t.Fatal(err)
				}
				select {
				case <-sh.Exited():
				case <-time.After(10 * time.Second):
					t.Fatal("a shell stayed open in a folder that does not exist")
				}
				if code, ok := sh.ExitStatus(); !ok || code == 0 {
					t.Fatalf("exit status %d %v", code, ok)
				}
			})

			t.Run("the keepalive is answered by a real server", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				pulses := make(chan Pulse, 16)
				l.Watch(100*time.Millisecond, 2*time.Second, func(p Pulse) { pulses <- p })
				for i := 0; i < 3; i++ {
					select {
					case p := <-pulses:
						if p.Silent || p.RoundTrip < 0 || p.RoundTrip > time.Second {
							t.Fatalf("%+v", p)
						}
					case <-time.After(5 * time.Second):
						t.Fatal("no answer to the keepalive")
					}
				}
			})

			// The case the app exists for: the link goes silent for a while and comes back. The job that was
			// running on the box is still running, in the same session, and its output arrives.
			t.Run("a silent link comes back to the same running job", func(t *testing.T) {
				p, err := faultproxy.Listen(box.honest)
				if err != nil {
					t.Fatal(err)
				}
				defer p.Close()
				via := honest
				via.Addr = p.Addr()
				l, err := Dial(context.Background(), via, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				result := make(chan string, 1)
				go func() {
					s, err := tryRun(l, "echo started; sleep 4; echo finished $$", 30*time.Second)
					if err != nil {
						s = "FAILED: " + err.Error()
					}
					result <- s
				}()
				time.Sleep(time.Second)
				p.Set(faultproxy.Faults{Hold: true})
				select {
				case <-l.Done():
					t.Fatalf("a silent link was ended: %v", l.End())
				case s := <-result:
					t.Fatalf("output came through a held link: %q", s)
				case <-time.After(6 * time.Second): // the job has finished on the box by now; we have heard nothing
				}
				p.Set(faultproxy.Faults{})
				got := <-result
				if !strings.HasPrefix(got, "started\nfinished ") {
					t.Fatalf("after the link came back: %q", got)
				}
				if p.Open() != 1 {
					t.Fatalf("the link was reconnected: %d connections", p.Open())
				}
			})
		})
	}
}
