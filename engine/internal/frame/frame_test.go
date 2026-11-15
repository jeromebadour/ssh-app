package frame

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"testing"
)

type vectors struct {
	Valid []struct {
		Name  string `json:"name"`
		Type  int    `json:"type"`
		Body  string `json:"body"`
		Frame string `json:"frame"`
	} `json:"valid"`
	Invalid []struct {
		Name  string `json:"name"`
		Bytes string `json:"bytes"`
		Error string `json:"error"`
	} `json:"invalid"`
}

func load(t testing.TB) vectors {
	t.Helper()
	raw, err := os.ReadFile("../../../protocol/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Valid) == 0 || len(v.Invalid) == 0 {
		t.Fatal("vectors file is empty")
	}
	return v
}

func unhex(t testing.TB, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestVectorsValid(t *testing.T) {
	for _, c := range load(t).Valid {
		body, want := unhex(t, c.Body), unhex(t, c.Frame)
		got, err := Append(nil, byte(c.Type), body)
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s: encode gave %x (%v), want %x", c.Name, got, err, want)
		}
		f, err := Read(bytes.NewReader(want))
		if err != nil || f.Type != byte(c.Type) || !bytes.Equal(f.Body, body) {
			t.Errorf("%s: decode gave type %#x body %x (%v)", c.Name, f.Type, f.Body, err)
		}
	}
}

func TestVectorsInvalid(t *testing.T) {
	want := map[string]error{"empty": ErrEmpty, "too-large": ErrTooLarge, "truncated": io.ErrUnexpectedEOF}
	for _, c := range load(t).Invalid {
		_, err := Read(bytes.NewReader(unhex(t, c.Bytes)))
		if w, ok := want[c.Error]; !ok || !errors.Is(err, w) {
			t.Errorf("%s: got %v, want %s", c.Name, err, c.Error)
		}
	}
}

func TestLimits(t *testing.T) {
	if _, err := Append(nil, TypeOutput, make([]byte, MaxPayload)); !errors.Is(err, ErrTooLarge) {
		t.Errorf("a body of MaxPayload bytes must be refused, got %v", err)
	}
	full, err := Append(nil, TypeOutput, make([]byte, MaxPayload-1))
	if err != nil {
		t.Fatal(err)
	}
	if f, err := Read(bytes.NewReader(full)); err != nil || len(f.Body) != MaxPayload-1 {
		t.Errorf("the largest frame must round-trip, got %d bytes (%v)", len(f.Body), err)
	}
	if _, err := Read(bytes.NewReader(nil)); err != io.EOF {
		t.Errorf("a clean end must be io.EOF, got %v", err)
	}
}

// FuzzRead: whatever bytes arrive, Read returns a frame within the limits or an error, and never panics.
func FuzzRead(f *testing.F) {
	v := load(f)
	for _, c := range v.Valid {
		f.Add(unhex(f, c.Frame))
	}
	for _, c := range v.Invalid {
		f.Add(unhex(f, c.Bytes))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		r := bytes.NewReader(data)
		for {
			fr, err := Read(r)
			if err != nil {
				return
			}
			if len(fr.Body)+1 > MaxPayload {
				t.Fatalf("frame over the limit: %d", len(fr.Body))
			}
			again, err := Append(nil, fr.Type, fr.Body)
			if err != nil {
				t.Fatal(err)
			}
			if back, err := Read(bytes.NewReader(again)); err != nil || back.Type != fr.Type || !bytes.Equal(back.Body, fr.Body) {
				t.Fatalf("round trip changed the frame (%v)", err)
			}
		}
	})
}
