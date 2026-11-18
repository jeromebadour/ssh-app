package main

// What it costs to open a trash that has a lot in it, on a link with real distance in it. The record used to
// be one file: one open and one read, whatever was in the trash. It is a file per thing now, so the trash is
// read a record at a time, and every record is its own round trip. At any distance that is the whole wait.

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"sshapp/engine/internal/lab/faultproxy"
	"sshapp/engine/internal/lab/hostile"
	"sshapp/engine/internal/link"
	"sshapp/engine/internal/sftp"
)

// howManyInTheTrash is enough to tell a round trip per thing from a handful of rounds, and small enough that
// the probe is quick even when it is the slow way round.
const howManyInTheTrash = 96

// eachWay is the distance put on the link: a box one country away, as plan B4.1's own measurement uses.
const eachWay = 25 * time.Millisecond

// aTrashWith fills a trash on a box's own disk with n things, each with a record of its own.
func aTrashWith(t *testing.T, root string, n int) {
	t.Helper()
	bin := filepath.Join(root, ".berth-trash")
	if err := os.MkdirAll(filepath.Join(bin, recordsIn), 0o700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < n; i++ {
		l := trashed{
			Name: fmt.Sprintf("1700000000-%03d-thing%03d.txt", i, i),
			From: fmt.Sprintf("/srv/app/thing%03d.txt", i),
			When: 1700000000,
			Size: 40,
			Kind: "file",
		}
		if err := os.WriteFile(filepath.Join(bin, l.Name), make([]byte, 40), 0o600); err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(l)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(bin, recordsIn, l.Name+".json"), append(body, '\n'), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

// aLinkAtADistance gives back a file layer on a box reached through a proxy that holds every chunk back by
// the distance asked for, each way, as plan B4.1's own speed measurement does.
func aLinkAtADistance(t *testing.T, root string, oneWay time.Duration) *sftp.Client {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	host, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatal(err)
	}
	_, userPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	user, err := ssh.NewSignerFromKey(userPriv)
	if err != nil {
		t.Fatal(err)
	}
	box, err := hostile.Start(hostile.Config{HostSigner: host, Accept: user.PublicKey(), Sessions: true, FilesUnder: root})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(box.Close)
	proxy, err := faultproxy.Listen(box.Addr())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(proxy.Close)
	proxy.Set(faultproxy.Faults{Delay: oneWay})
	ctx, stop := context.WithTimeout(context.Background(), 10*time.Minute)
	t.Cleanup(stop)
	l, err := link.Dial(ctx, link.Target{Addr: proxy.Addr(), User: "demo", HostKey: host.PublicKey()}, user, link.Options{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(l.Close)
	files, err := l.OpenFiles(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	c, err := sftp.Start(ctx, files)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// A trash with ninety-six things in it, on a box 25 ms away. Read a record at a time that is three round
// trips each and the pane shows nothing for all of them; read sftp.AtOnce at a time it is a handful of
// rounds. The gate is set where one-at-a-time cannot come back unseen.
func TestATrashWithALotInItOpensInRoundsNotOneThingAtATime(t *testing.T) {
	if testing.Short() {
		t.Skip("short")
	}
	root := t.TempDir()
	aTrashWith(t, root, howManyInTheTrash)
	c := aLinkAtADistance(t, root, eachWay)
	ctx := context.Background()

	began := time.Now()
	held, err := readRecords(ctx, c, "/.berth-trash")
	took := time.Since(began)
	if err != nil {
		t.Fatalf("the trash could not be read: %v", err)
	}
	if len(held) != howManyInTheTrash {
		t.Fatalf("%d things listed of %d", len(held), howManyInTheTrash)
	}
	perThing := took / howManyInTheTrash
	t.Logf("%d things in the trash, %v each way: %v in all, %v a thing", howManyInTheTrash, eachWay, took.Round(time.Millisecond), perThing.Round(time.Millisecond))
	// One record at a time costs an open and two reads each: three round trips, 150 ms at this distance, so
	// ninety-six of them is about fourteen seconds. Anything near that number is the one-at-a-time loop back.
	if took > 4*time.Second {
		t.Fatalf("reading the trash took %v: at %v each way that is a round trip per thing, not a round of them", took.Round(time.Millisecond), eachWay)
	}
}
