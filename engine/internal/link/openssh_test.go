package link

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	sshappsftp "sshapp/engine/internal/sftp"

	"sshapp/engine/internal/lab/faultproxy"
)

// The link against real OpenSSH servers (plan B9): the newest, and 8.9, the oldest the app supports. They run
// in containers that scripts/lab-openssh.sh starts, in CI only; LAB_OPENSSH is the folder that script wrote.
// Without it these tests are skipped, except when LAB_OPENSSH_REQUIRED is set: then a missing lab is a failure.

type realBox struct {
	name, honest, rsaOnly, weakCipher, kex, version string
	withPassword                                    string // the one server in this lab that takes a password
}

type realLab struct {
	boxes    []realBox
	user     ssh.Signer
	hostEd   ssh.PublicKey
	hostRSA  ssh.PublicKey
	password string // this run's own password for the one server that takes one; made fresh, never committed
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
	lab := &realLab{user: user, hostEd: pub("host_ed.pub"), hostRSA: pub("host_rsa.pub"), password: strings.TrimSpace(string(read("firstvisit-password")))}
	sc := bufio.NewScanner(strings.NewReader(string(read("boxes"))))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) != 7 {
			t.Fatalf("a line of the lab's box list is not seven words: %q", sc.Text())
		}
		lab.boxes = append(lab.boxes, realBox{f[0], f[1], f[2], f[3], f[4], f[5], f[6]})
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

			// The first-connection check (plan B2.3) against the real thing: asking gives the identity the
			// server really has; the fingerprint we compute is, to the letter, what the box's own ssh-keygen
			// prints; and the one block the app asks to be run does what it says on a real box.
			t.Run("the first-connection check: who the box is, and what the box itself prints", func(t *testing.T) {
				key, e := Identify(context.Background(), box.honest, Options{})
				if e != nil || string(key.Marshal()) != string(lab.hostEd.Marshal()) {
					t.Fatalf("asked who it is: %v %v", key, e)
				}
				key, e = Identify(context.Background(), box.rsaOnly, Options{})
				if e != nil || string(key.Marshal()) != string(lab.hostRSA.Marshal()) {
					t.Fatalf("a box with an RSA identity only: %v %v", key, e)
				}
				if _, e = Identify(context.Background(), box.weakCipher, Options{}); e == nil || e.Cause != WeakOffer || e.What != "cipher" {
					t.Fatalf("a box with only a cipher we refuse: %v", e)
				}

				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				printed := strings.TrimSpace(run(t, l, "ssh-keygen -lf /lab/host_ed.pub", 10*time.Second))
				if want := "256 " + ssh.FingerprintSHA256(lab.hostEd) + " lab-host (ED25519)"; printed != want {
					t.Fatalf("the box prints %q; we would compare with %q", printed, want)
				}
				printed = strings.TrimSpace(run(t, l, "ssh-keygen -lf /lab/host_rsa.pub", 10*time.Second))
				if want := "3072 " + ssh.FingerprintSHA256(lab.hostRSA) + " lab-host (RSA)"; printed != want {
					t.Fatalf("the box prints %q; we would compare with %q", printed, want)
				}

				// The block, as the app gives it, with a key made for this run.
				raw, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "first-connection.json"))
				if err != nil {
					t.Fatal(err)
				}
				var doc struct{ Block string }
				if err := json.Unmarshal(raw, &doc); err != nil || !strings.Contains(doc.Block, "{KEY}") {
					t.Fatalf("the block's text could not be read: %v", err)
				}
				fresh := edKey(t)
				line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(fresh.PublicKey()))) + " berth:" + box.name
				run(t, l, "rm -rf ~/.ssh", 10*time.Second)
				out := run(t, l, strings.ReplaceAll(doc.Block, "{KEY}", line), 15*time.Second)
				shown := 0
				for _, ln := range strings.Split(strings.TrimSpace(out), "\n") {
					f := strings.Fields(ln)
					if len(f) >= 4 && strings.HasPrefix(f[1], "SHA256:") && len(f[1]) == 50 && strings.HasPrefix(f[len(f)-1], "(") {
						shown++
					}
				}
				if shown == 0 {
					t.Fatalf("the block printed no identity line: %q", out)
				}
				if got := run(t, l, "cat ~/.ssh/authorized_keys; stat -c '%a' ~/.ssh ~/.ssh/authorized_keys", 10*time.Second); got != line+"\n700\n600\n" {
					t.Fatalf("after the block, the key file and its rights are: %q", got)
				}
				t.Logf("the block printed %d identity lines", shown)
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

			// The file protocol, against a real server's own sftp subsystem: what this app's file browser,
			// its viewer and every transfer will run on.
			t.Run("the file protocol: a real listing, a real file, and the disk's free space", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()

				// A folder of our own with known contents, made through the shell so the listing is compared
				// with something this test did not write through the protocol it is testing.
				dir := "/tmp/berth-files-" + box.name
				run(t, l, "rm -rf "+dir+"; mkdir -p "+dir+"/sub && printf 'hello files' > "+dir+"/one.txt && ln -s one.txt "+dir+"/a-link && echo done", 15*time.Second)

				files, err := l.OpenFiles()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer cancel()
				c, err := sshappsftp.Start(ctx, files)
				if err != nil {
					t.Fatalf("the file protocol did not start: %v", err)
				}
				defer c.Close()

				// Where "." is, as the box itself works it out.
				home, err := c.Realpath(ctx, ".")
				if err != nil || home == "" {
					t.Fatalf("realpath gave %q, %v", home, err)
				}

				// The listing: every row, and what each one is.
				kinds := map[string]string{}
				if err := c.List(ctx, dir, func(e []sshappsftp.Entry) error {
					for _, x := range e {
						kinds[x.Name] = x.Attrs.Kind()
					}
					return nil
				}); err != nil {
					t.Fatalf("the listing failed: %v", err)
				}
				if kinds["one.txt"] != "file" || kinds["sub"] != "folder" || kinds["a-link"] != "link" {
					t.Fatalf("the listing says %v; a file, a folder and a link must each be known as itself", kinds)
				}
				if _, there := kinds["."]; there {
					t.Fatal("the listing carried \".\", which is the folder itself")
				}

				// A file read back byte for byte.
				f, err := c.Open(ctx, dir+"/one.txt")
				if err != nil {
					t.Fatal(err)
				}
				buf := make([]byte, 64)
				n, err := f.ReadAt(ctx, buf, 0)
				if err != nil {
					t.Fatal(err)
				}
				if string(buf[:n]) != "hello files" {
					t.Fatalf("the file read back as %q", buf[:n])
				}
				// And from a place inside it, which is what a transfer taken up again does.
				n, err = f.ReadAt(ctx, buf, 6)
				if err != nil || string(buf[:n]) != "files" {
					t.Fatalf("reading from the sixth byte gave %q, %v", buf[:n], err)
				}
				if err := f.Close(ctx); err != nil {
					t.Fatal(err)
				}

				// A file written, read back, and moved into place as a transfer does.
				w, err := c.Create(ctx, dir+"/new.part", 0o600)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := w.WriteAt(ctx, []byte("written by Berth"), 0); err != nil {
					t.Fatal(err)
				}
				if err := w.Close(ctx); err != nil {
					t.Fatal(err)
				}
				if err := c.Rename(ctx, dir+"/new.part", dir+"/one.txt"); err != nil {
					t.Fatalf("the rename failed: %v", err)
				}
				back := run(t, l, "cat "+dir+"/one.txt", 10*time.Second)
				if back != "written by Berth" {
					t.Fatalf("after the move the file holds %q", back)
				}

				// Creating a file that is already there is refused, never silently replaced.
				if _, err := c.Create(ctx, dir+"/one.txt", 0o600); err == nil {
					t.Fatal("a file that is already there was replaced")
				}

				// Where a link points, without following it.
				if to, err := c.Readlink(ctx, dir+"/a-link"); err != nil || to != "one.txt" {
					t.Fatalf("the link reads as %q, %v", to, err)
				}

				// A file that is not there is said as that, not as some other failure.
				if _, err := c.Stat(ctx, dir+"/nothing-here"); !errors.Is(err, sshappsftp.ErrNoSuchFile) {
					t.Fatalf("a missing file gave %v", err)
				}

				// The disk, as OpenSSH's own extension reports it.
				if !c.Can("statvfs@openssh.com") {
					t.Fatal("a real OpenSSH server did not offer the extension this app reads free space from")
				}
				sp, err := c.Space(ctx, dir)
				if err != nil {
					t.Fatal(err)
				}
				if sp.Total == 0 || sp.Free == 0 || sp.Free > sp.Total {
					t.Fatalf("the disk reads as %+v", sp)
				}

				// And the terminal on the same link is untouched by all of it.
				if got := run(t, l, "echo still here", 10*time.Second); got != "still here\n" {
					t.Fatalf("after the file work the shell said %q", got)
				}
				run(t, l, "rm -rf "+dir+" && echo cleaned", 10*time.Second)
			})

			// The one thing this app runs on a box for a transfer (plan B2.5, entry 3): a file's hash, on a
			// channel of its own, never in the terminal.
			// The heart of a download, against a real box: the bytes our own file client reads back are the
			// bytes the box has, and the box's own hash of them is the hash of what we read. The engine does
			// exactly this and then renames the file into place; what could differ between a lab box and a
			// real one is this part, which is why it is proved here on both supported server versions.
			t.Run("a real file read back matches the box's own hash of it", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				dir := "/tmp/berth-get-" + box.name
				// Three megabytes of a box's own random bytes: more than one read, and nothing this test
				// could have written through the protocol it is testing.
				run(t, l, "rm -rf "+dir+" && mkdir -p "+dir+" && head -c 3145728 /dev/urandom > "+dir+"/blob.bin && echo done", 30*time.Second)

				files, err := l.OpenFiles()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
				defer cancel()
				c, err := sshappsftp.Start(ctx, files)
				if err != nil {
					t.Fatalf("the file protocol did not start: %v", err)
				}
				defer c.Close()

				at, err := c.Stat(ctx, dir+"/blob.bin")
				if err != nil || at.Size != 3145728 {
					t.Fatalf("stat: %v, %d", err, at.Size)
				}
				f, err := c.Open(ctx, dir+"/blob.bin")
				if err != nil {
					t.Fatal(err)
				}
				sum := sha256.New()
				buf := make([]byte, sshappsftp.Block)
				var got uint64
				for {
					n, err := f.ReadAt(ctx, buf, got)
					if n > 0 {
						sum.Write(buf[:n])
						got += uint64(n)
					}
					if errors.Is(err, io.EOF) {
						break
					}
					if err != nil {
						t.Fatalf("reading it back: %v", err)
					}
					if n == 0 {
						break
					}
				}
				_ = f.Close(ctx)
				if got != at.Size {
					t.Fatalf("read %d bytes of %d", got, at.Size)
				}
				here := hex.EncodeToString(sum.Sum(nil))
				there, err := l.Hash(ctx, SHA256, dir+"/blob.bin")
				if err != nil {
					t.Fatalf("the box did not give a hash: %v", err)
				}
				if here != there {
					t.Fatalf("what came back is not what the box has: read %s, box says %s", here, there)
				}
				run(t, l, "rm -rf "+dir+" && echo done", 15*time.Second)
			})

			// The heart of an upload, against a real box: bytes written through our own file client are the
			// bytes the box ends up with, its own hash agrees, a replaced file's permissions are put back on
			// the new one, and the rename really is atomic replacement on a real server.
			t.Run("a real file written to a box matches the box's own hash, and replaces one in place", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				dir := "/tmp/berth-put-" + box.name
				run(t, l, "rm -rf "+dir+" && mkdir -p "+dir+" && printf 'the old one\n' > "+dir+"/live.conf && chmod 600 "+dir+"/live.conf && echo done", 20*time.Second)

				files, err := l.OpenFiles()
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
				defer cancel()
				c, err := sshappsftp.Start(ctx, files)
				if err != nil {
					t.Fatalf("the file protocol did not start: %v", err)
				}
				defer c.Close()

				// A megabyte of our own bytes, written the way the engine writes them.
				body := make([]byte, 1<<20)
				if _, err := rand.Read(body); err != nil {
					t.Fatal(err)
				}
				temp := dir + "/.berth-1.part"
				f, err := c.Create(ctx, temp, 0o600)
				if err != nil {
					t.Fatal(err)
				}
				for at := 0; at < len(body); at += sshappsftp.Block {
					end := at + sshappsftp.Block
					if end > len(body) {
						end = len(body)
					}
					if _, err := f.WriteAt(ctx, body[at:end], uint64(at)); err != nil {
						t.Fatalf("writing: %v", err)
					}
				}
				// The permissions of what is being replaced, put on before it is in place.
				was, err := c.Lstat(ctx, dir+"/live.conf")
				if err != nil {
					t.Fatal(err)
				}
				if err := f.Chmod(ctx, was.Mode&0o7777); err != nil {
					t.Fatalf("permissions: %v", err)
				}
				if err := f.Close(ctx); err != nil {
					t.Fatal(err)
				}

				sum := sha256.Sum256(body)
				there, err := l.Hash(ctx, SHA256, temp)
				if err != nil {
					t.Fatalf("the box did not give a hash: %v", err)
				}
				if there != hex.EncodeToString(sum[:]) {
					t.Fatalf("what the box holds is not what was written: box says %s", there)
				}
				if err := c.Rename(ctx, temp, dir+"/live.conf"); err != nil {
					t.Fatalf("the rename into place failed: %v", err)
				}
				// The box's own view of the result: the right size, the right hash, the old permissions.
				after, err := c.Lstat(ctx, dir+"/live.conf")
				if err != nil || after.Size != uint64(len(body)) || after.Mode&0o7777 != 0o600 {
					t.Fatalf("after the rename: %v, %d bytes, mode %o", err, after.Size, after.Mode&0o7777)
				}
				nowThere, err := l.Hash(ctx, SHA256, dir+"/live.conf")
				if err != nil || nowThere != hex.EncodeToString(sum[:]) {
					t.Fatalf("the file in place is not the one that was written: %v, %s", err, nowThere)
				}
				if left, err := c.Lstat(ctx, temp); err == nil {
					t.Fatalf("the temporary name is still there: %v", left)
				}
				run(t, l, "rm -rf "+dir+" && echo done", 15*time.Second)
			})

			t.Run("a file's hash, asked of a real box, matches what it really is", func(t *testing.T) {
				l, err := Dial(context.Background(), honest, lab.user, Options{})
				if err != nil {
					t.Fatal(err)
				}
				defer l.Close()
				dir := "/tmp/berth-hash-" + box.name
				body := "the bytes whose hash this test knows\n"
				run(t, l, "rm -rf "+dir+" && mkdir -p "+dir+" && printf %s '"+body+"' > "+dir+"/plain.txt && echo done", 15*time.Second)
				// And a name holding the things a shell would act on, to prove the quoting on a real shell.
				odd := dir + "/it's $(id) `id` \"x\" ;rm -rf / *.txt"
				run(t, l, "cp "+dir+"/plain.txt '"+strings.ReplaceAll(odd, "'", `'\''`)+"' && echo done", 15*time.Second)

				want := sha256.Sum256([]byte(body))
				wantHex := hex.EncodeToString(want[:])

				ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
				defer cancel()
				got, err := l.Hash(ctx, SHA256, dir+"/plain.txt")
				if err != nil {
					t.Fatalf("the box did not give a hash: %v", err)
				}
				if got != wantHex {
					t.Fatalf("the box said %s, the bytes are %s", got, wantHex)
				}

				// The same file under a name full of things a shell acts on: the same hash, and nothing ran.
				oddHash, err := l.Hash(ctx, SHA256, odd)
				if err != nil {
					t.Fatalf("a name a shell would act on was not handled: %v", err)
				}
				if oddHash != wantHex {
					t.Fatalf("under an awkward name the box said %s, not %s", oddHash, wantHex)
				}
				if left := run(t, l, "ls "+dir+" | wc -l", 10*time.Second); strings.TrimSpace(left) != "2" {
					t.Fatalf("the folder holds %s things: something in a name was acted on", strings.TrimSpace(left))
				}

				// md5 as well, which is the one the owner asks for by hand.
				md5Got, err := l.Hash(ctx, MD5, dir+"/plain.txt")
				if err != nil || len(md5Got) != 32 {
					t.Fatalf("md5 gave %q, %v", md5Got, err)
				}

				// A file that is not there is a refusal, not a hash of nothing.
				if _, err := l.Hash(ctx, SHA256, dir+"/not-here"); err == nil {
					t.Fatal("a file that is not there gave a hash")
				}

				// None of it touched the terminal: the shell on this link still answers.
				if got := run(t, l, "echo still here", 10*time.Second); got != "still here\n" {
					t.Fatalf("after the hashes the shell said %q", got)
				}
				run(t, l, "rm -rf "+dir+" && echo cleaned", 10*time.Second)
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

// The first visit, against a real OpenSSH that really takes a password (decision O2). This is the one place
// in the whole app where a password is ever offered, so it is proved here and not only against our own box:
// what matters is that a real sshd accepts it, that the one command really lands, and that the key it installs
// really lets Berth back in without it.
func TestOpenSSHFirstVisit(t *testing.T) {
	lab := openLab(t)
	if lab.password == "" {
		t.Fatal("the lab made no password for its password server")
	}
	block, err := os.ReadFile(filepath.Join("..", "..", "..", "protocol", "first-connection.json"))
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Block string `json:"block"`
	}
	if err := json.Unmarshal(block, &file); err != nil || file.Block == "" {
		t.Fatalf("the one block Berth runs could not be read: %v", err)
	}

	for _, b := range lab.boxes {
		t.Run(b.name, func(t *testing.T) {
			target := Target{Addr: b.withPassword, User: "firstvisit", HostKey: lab.hostEd}
			line := strings.TrimSpace(string(ssh.MarshalAuthorizedKey(lab.user.PublicKey())))
			command := strings.ReplaceAll(file.Block, "{KEY}", line)

			// A wrong password is refused, and nothing is run.
			if _, e := FirstVisit(t.Context(), target, lab.password+"-wrong", command, Options{}); e == nil {
				t.Fatal("a wrong password was taken")
			}

			// A box that is not the one pinned never sees the password at all: the identity is compared
			// before any sign-in is tried, which is the whole of decision O2's argument.
			if _, e := FirstVisit(t.Context(), Target{Addr: b.withPassword, User: "firstvisit", HostKey: lab.hostRSA}, lab.password, command, Options{}); e == nil || e.Cause != IdentityChanged {
				t.Fatalf("a box showing another identity was not stopped: %v", e)
			}

			// The right password: the block runs, and the box prints its own fingerprints as it does.
			said, e := FirstVisit(t.Context(), target, lab.password, command, Options{})
			if e != nil {
				t.Fatalf("the first visit failed: %v", e)
			}
			if !strings.Contains(said, "SHA256:") {
				t.Fatalf("the box printed no fingerprints: %q", said)
			}

			// And now the key alone gets in, with no password anywhere, which is the thing the visit exists
			// for. Proving it this way and not by reading authorized_keys is the point: what matters is that
			// the key works, not that a file looks right.
			l, derr := Dial(t.Context(), target, lab.user, Options{})
			if derr != nil {
				t.Fatalf("the key the visit installed does not let Berth in: %v", derr)
			}
			l.Close()
		})
	}
}
