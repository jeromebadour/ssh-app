package sftp_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
	"sshapp/engine/internal/link"
	sshappsftp "sshapp/engine/internal/sftp"
)

func newSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// How fast the bulk path really is when the box is not next door. One request at a time means one round
// trip per block, so the distance, not the link, decides the speed. This is the measurement plan B4.1 asks
// for before the decision to write our own layer is kept.
func TestHowFastTheBulkPathIsAtADistance(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	dir := t.TempDir()
	big := filepath.Join(dir, "big.bin")
	const size = 4 << 20
	b := make([]byte, size)
	if _, err := rand.Read(b[:1<<16]); err != nil {
		t.Fatal(err)
	}
	for at := 1 << 16; at < size; at += 1 << 16 {
		copy(b[at:], b[:1<<16])
	}
	if err := os.WriteFile(big, b, 0o600); err != nil {
		t.Fatal(err)
	}
	host, user := newSigner(t), newSigner(t)
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: user.PublicKey(), Sessions: true, FilesUnder: dir})
	if err != nil {
		t.Fatal(err)
	}
	defer box.Close()
	proxy, err := faultproxy.Listen(box.Addr())
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	for _, oneWay := range []time.Duration{0, 25 * time.Millisecond} {
		proxy.Set(faultproxy.Faults{Delay: oneWay})
		ctx, stop := context.WithTimeout(context.Background(), 5*time.Minute)
		l, err := link.Dial(ctx, link.Target{Addr: proxy.Addr(), User: "demo", HostKey: host.PublicKey()}, user, link.Options{})
		if err != nil {
			stop()
			t.Fatalf("delay %v: %v", oneWay, err)
		}
		files, err := l.OpenFiles()
		if err != nil {
			t.Fatal(err)
		}
		c, err := sshappsftp.Start(ctx, files)
		if err != nil {
			t.Fatal(err)
		}
		f, err := c.Open(ctx, "/big.bin")
		if err != nil {
			t.Fatal(err)
		}
		began := time.Now()
		var got uint64
		if err := f.ReadInOrder(ctx, 0, func(p []byte, at uint64) error {
			if at != got {
				t.Fatalf("a block arrived at %d where %d was due: the bytes must reach the hash in the order they sit in the file", at, got)
			}
			got += uint64(len(p))
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if got != size {
			t.Fatalf("read %d bytes of %d", got, size)
		}
		took := time.Since(began)
		rate := float64(size>>20) / took.Seconds()
		t.Logf("%d MiB with %v each way: %v, %.2f MiB/s", size>>20, oneWay, took.Round(time.Millisecond), rate)
		// The gate the measurement exists for: at this distance a plain one-ask-at-a-time loop gives about
		// 0.6 MiB/s, which is most of a day for a 5 GB file. Anything near that number is the loop back.
		if oneWay > 0 && rate < 5 {
			t.Fatalf("the bulk path gives %.2f MiB/s at %v each way; one ask at a time gives about 0.6", rate, oneWay)
		}
		c.Close()
		l.Close()
		stop()
	}
}
