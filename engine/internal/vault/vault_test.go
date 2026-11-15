package vault

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"testing"
	"time"
)

// The cheapest cost the range allows: these tests check the envelope, not Argon2id's strength.
var cheap = Params{Time: MinTime, MemoryKiB: MinMemoryKiB, Threads: 2}

var (
	testPassword = []byte("a long enough password")
	testContents = []byte(`{"boxes":[{"name":"demo-eu"}]}`)
	testSavedAt  = time.Date(2026, 11, 16, 1, 2, 3, 0, time.UTC)
)

func sealed(t testing.TB) ([]byte, *Key) {
	t.Helper()
	k, err := NewKey(testPassword, cheap)
	if err != nil {
		t.Fatal(err)
	}
	out, err := k.Seal(testContents, testSavedAt)
	if err != nil {
		t.Fatal(err)
	}
	return out, k
}

// Rewrites the header digest after a deliberate change to the header, as a careful attacker would.
func redigest(file []byte) {
	d := sha256.Sum256(file[:offDigest])
	copy(file[offDigest:], d[:digestLen])
}

func TestRoundTrip(t *testing.T) {
	file, _ := sealed(t)
	got, key, info, err := Open(testPassword, file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, testContents) {
		t.Fatalf("contents came back as %q", got)
	}
	if !info.SavedAt.Equal(testSavedAt) || info.Params != cheap {
		t.Fatalf("info came back as %+v", info)
	}

	// The key Open hands back saves again without the password, and the same password opens that too.
	again, err := key.Seal([]byte("changed"), testSavedAt.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	got, _, info, err = Open(testPassword, again)
	if err != nil || string(got) != "changed" || !info.SavedAt.Equal(testSavedAt.Add(time.Hour)) {
		t.Fatalf("second save: %q %+v %v", got, info, err)
	}
}

func TestEmptyContents(t *testing.T) {
	k, _ := NewKey(testPassword, cheap)
	file, err := k.Seal(nil, testSavedAt)
	if err != nil {
		t.Fatal(err)
	}
	got, _, _, err := Open(testPassword, file)
	if err != nil || len(got) != 0 {
		t.Fatalf("%q %v", got, err)
	}
}

func TestEverySaveDiffers(t *testing.T) {
	a, k := sealed(t)
	b, err := k.Seal(testContents, testSavedAt)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(a[offNonce:offDigest], b[offNonce:offDigest]) {
		t.Fatal("two saves used the same nonce")
	}
	if bytes.Equal(a[headerLen:], b[headerLen:]) {
		t.Fatal("two saves of the same contents gave the same sealed bytes")
	}
	other, _ := NewKey(testPassword, cheap)
	if bytes.Equal(other.salt[:], k.salt[:]) || other.seal == k.seal {
		t.Fatal("two new keys from one password are the same key")
	}
}

func TestWrongPassword(t *testing.T) {
	file, _ := sealed(t)
	for _, pw := range []string{"a long enough passworD", "a long enough password ", "x"} {
		if got, key, _, err := Open([]byte(pw), file); !errors.Is(err, ErrPassword) || got != nil || key != nil {
			t.Fatalf("password %q: %v", pw, err)
		}
	}
	if _, _, _, err := Open(nil, file); !errors.Is(err, ErrNoPassword) {
		t.Fatalf("no password: %v", err)
	}
}

// One changed byte anywhere is refused, and nothing comes out (plan B10: the saved list cannot be altered unseen).
// A change in the header is caught before any password work; in the check value it reads as a wrong password;
// in the contents as damage.
func TestOneChangedByteAnywhere(t *testing.T) {
	file, _ := sealed(t)
	for i := range file {
		bad := bytes.Clone(file)
		bad[i] ^= 0x01
		got, key, _, err := Open(testPassword, bad)
		if err == nil || got != nil || key != nil {
			t.Fatalf("byte %d changed: opened", i)
		}
		var want error
		switch {
		case i < len(magic):
			want = ErrNotAList
		case i == offVersion:
			want = ErrDamaged // version 0; a higher one is ErrNewer, tested below
		case i < offCheck:
			want = ErrDamaged
		case i < headerLen:
			want = ErrPassword
		default:
			want = ErrDamaged
		}
		if !errors.Is(err, want) {
			t.Fatalf("byte %d changed: %v, wanted %v", i, err, want)
		}
	}
}

// The same changes made by someone who also repairs the header digest: still refused. The header is bound to
// the password by the check value and to the contents as additional data.
func TestHeaderChangedAndDigestRepaired(t *testing.T) {
	file, _ := sealed(t)
	for _, i := range []int{offSavedAt + 7, offSalt, offNonce, offNonce + nonceLen - 1} {
		bad := bytes.Clone(file)
		bad[i] ^= 0x80
		redigest(bad)
		if got, _, _, err := Open(testPassword, bad); !errors.Is(err, ErrPassword) || got != nil {
			t.Fatalf("byte %d changed, digest repaired: %v", i, err)
		}
	}
}

func TestCutShortAtEveryLength(t *testing.T) {
	file, _ := sealed(t)
	for n := 0; n < len(file); n++ {
		got, _, _, err := Open(testPassword, file[:n])
		if err == nil || got != nil {
			t.Fatalf("cut to %d bytes: opened", n)
		}
		if n < len(magic) && !errors.Is(err, ErrNotAList) {
			t.Fatalf("cut to %d bytes: %v", n, err)
		}
		if n >= len(magic) && !errors.Is(err, ErrDamaged) {
			t.Fatalf("cut to %d bytes: %v", n, err)
		}
	}
	if _, _, _, err := Open(testPassword, append(bytes.Clone(file), 0)); !errors.Is(err, ErrDamaged) {
		t.Fatalf("one byte added: %v", err)
	}
}

func TestNotAList(t *testing.T) {
	for _, in := range [][]byte{nil, {}, []byte("BERTH"), []byte("PuTTY-User-Key-File-3: ssh-ed25519\n"), bytes.Repeat([]byte{0}, 500)} {
		if _, _, _, err := Open(testPassword, in); !errors.Is(err, ErrNotAList) {
			t.Fatalf("%q: %v", in, err)
		}
	}
}

func TestNewerVersion(t *testing.T) {
	file, _ := sealed(t)
	file[offVersion] = version + 1
	redigest(file)
	if _, _, _, err := Open(testPassword, file); !errors.Is(err, ErrNewer) {
		t.Fatal(err)
	}
}

func TestUnknownKDFOrCipher(t *testing.T) {
	for _, off := range []int{offKDF, offCipher} {
		file, _ := sealed(t)
		file[off] = 2
		redigest(file)
		if _, _, _, err := Open(testPassword, file); !errors.Is(err, ErrDamaged) {
			t.Fatalf("offset %d: %v", off, err)
		}
	}
}

// Cost numbers outside the range are refused before they are used. The largest memory a file can ask for is
// 4 TiB: if Open tried it, this test would not survive.
func TestCostOutsideTheRange(t *testing.T) {
	type c struct {
		time, memory uint32
		threads      uint8
	}
	for _, bad := range []c{
		{0, MinMemoryKiB, 2}, {MaxTime + 1, MinMemoryKiB, 2}, {0xffffffff, MinMemoryKiB, 2},
		{1, MinMemoryKiB - 1, 2}, {1, 8, 2}, {1, 0, 2}, {1, MaxMemoryKiB + 1, 2}, {1, 0xffffffff, 2},
		{1, MinMemoryKiB, 0}, {1, MinMemoryKiB, MaxThreads + 1}, {1, MinMemoryKiB, 255},
	} {
		p := Params{Time: bad.time, MemoryKiB: bad.memory, Threads: bad.threads}
		if _, err := NewKey(testPassword, p); !errors.Is(err, ErrCost) {
			t.Fatalf("NewKey with %+v: %v", p, err)
		}
		file, _ := sealed(t)
		binary.BigEndian.PutUint32(file[offTime:], bad.time)
		binary.BigEndian.PutUint32(file[offMemory:], bad.memory)
		file[offThreads] = bad.threads
		redigest(file)
		if _, _, _, err := Open(testPassword, file); !errors.Is(err, ErrCost) {
			t.Fatalf("Open with %+v: %v", p, err)
		}
	}
	if !Default.inRange() {
		t.Fatal("the default cost is outside the range")
	}
}

func TestTooBig(t *testing.T) {
	k, _ := NewKey(testPassword, cheap)
	if _, err := k.Seal(make([]byte, MaxContents+1), testSavedAt); !errors.Is(err, ErrTooBig) {
		t.Fatal(err)
	}
	file, err := k.Seal(make([]byte, MaxContents), testSavedAt)
	if err != nil {
		t.Fatal(err)
	}
	if got, _, _, err := Open(testPassword, file); err != nil || len(got) != MaxContents {
		t.Fatalf("the largest list: %v", err)
	}
	if _, _, _, err := Open(testPassword, append(file, 0)); !errors.Is(err, ErrTooBig) {
		t.Fatal(err)
	}
}

func TestNoPassword(t *testing.T) {
	if _, err := NewKey(nil, cheap); !errors.Is(err, ErrNoPassword) {
		t.Fatal(err)
	}
}

func TestWipe(t *testing.T) {
	_, k := sealed(t)
	k.Wipe()
	if k.seal != [sealKeyLen]byte{} || k.check != [checkKeyLen]byte{} {
		t.Fatal("the key is still there after Wipe")
	}
	if _, err := k.Seal(testContents, testSavedAt); !errors.Is(err, ErrWiped) {
		t.Fatal(err)
	}
}

// A file made by a second, unrelated implementation from the written layout (testdata/make_vector.py) opens
// here, and the same inputs give the same bytes here. So the format is the one written down, not whatever this
// code happens to do.
func TestAgreesWithASecondImplementation(t *testing.T) {
	raw, err := os.ReadFile("testdata/v1.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Password, Contents, Salt, Nonce, Sealed string
		Time, MemoryKiB                         uint32
		Threads                                 uint8
		SavedAt                                 int64
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	want, _ := hex.DecodeString(v.Sealed)
	salt, _ := hex.DecodeString(v.Salt)
	nonce, _ := hex.DecodeString(v.Nonce)

	got, _, info, err := Open([]byte(v.Password), want)
	if err != nil || string(got) != v.Contents || info.SavedAt.Unix() != v.SavedAt {
		t.Fatalf("opening the other implementation's file: %q %+v %v", got, info, err)
	}

	k := &Key{params: Params{Time: v.Time, MemoryKiB: v.MemoryKiB, Threads: v.Threads}}
	copy(k.salt[:], salt)
	k.derive([]byte(v.Password))
	ours, err := k.sealWith([]byte(v.Contents), time.Unix(v.SavedAt, 0), nonce)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ours, want) {
		t.Fatalf("same inputs, different bytes:\n ours %x\n want %x", ours, want)
	}
}

// Whatever bytes arrive, Open never panics and never opens anything but the one genuine file. The genuine file
// is the fixed one in testdata: the fuzzer's workers are separate processes and must all mean the same file.
func FuzzOpen(f *testing.F) {
	raw, err := os.ReadFile("testdata/v1.json")
	if err != nil {
		f.Fatal(err)
	}
	var v struct{ Password, Sealed string }
	if err := json.Unmarshal(raw, &v); err != nil {
		f.Fatal(err)
	}
	genuine, _ := hex.DecodeString(v.Sealed)
	f.Add(genuine)
	f.Add(genuine[:headerLen])
	f.Add([]byte(magic))
	f.Add([]byte{})
	f.Fuzz(func(t *testing.T, in []byte) {
		got, key, _, err := Open([]byte(v.Password), in)
		if bytes.Equal(in, genuine) {
			if err != nil {
				t.Fatalf("the genuine file was refused: %v", err)
			}
			return
		}
		if err == nil || got != nil || key != nil {
			t.Fatalf("opened something that is not the genuine file (%d bytes)", len(in))
		}
	})
}
