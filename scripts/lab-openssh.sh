#!/usr/bin/env bash
# Real OpenSSH servers for the lab, in containers (plan B9). CI only: it needs a container engine.
#
#   lab-openssh.sh up     starts one container per line of toolchain/lab-images, each running three servers:
#                         an honest one, one whose only identity is an RSA key, and one that offers only a
#                         cipher the app refuses. Writes out/lab-openssh/ (keys made for this run, and `boxes`).
#   lab-openssh.sh down   removes them.
#
# Images are pinned by digest. A line whose digest is "unpinned" is not run: the script prints the digest and
# the OpenSSH version that image has today, and fails, so the line can be pinned by a person who has read them.
set -euo pipefail
cd "$(dirname "$0")/.."
dir="$PWD/out/lab-openssh"

down() { docker ps -aq --filter label=berth-lab | xargs -r docker rm -f >/dev/null; }

install_cmd() {
  case "$1" in
    apt) echo "export DEBIAN_FRONTEND=noninteractive; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends openssh-server >/dev/null && useradd -m -s /bin/sh demo && usermod -p '*' demo" ;;
    apk) echo "apk add --no-cache -q openssh-server >/dev/null && adduser -D -s /bin/sh demo && sed -i 's/^demo:!/demo:*/' /etc/shadow" ;;
    *) echo "lab-openssh: unknown package tool $1" >&2; exit 1 ;;
  esac
}

[ "${1:-}" = down ] && { down; exit 0; }
[ "${1:-}" = up ] || { echo "usage: lab-openssh.sh up|down" >&2; exit 2; }

down
rm -rf "$dir" && mkdir -p "$dir/mount"
# The password for this lab's one password server. It is made fresh for every run and written only into the
# run's own folder, never into the repository: a password committed anywhere is a password, whatever it guards.
# It is handed to the container in a file rather than on a command line, so it is not in what docker reports.
first_visit_password="$(head -c 18 /dev/urandom | base64 | tr -d '=+/' | head -c 20)"
printf 'firstvisit:%s\n' "$first_visit_password" > "$dir/mount/firstvisit-password"
printf '%s' "$first_visit_password" > "$dir/firstvisit-password"
chmod 600 "$dir/mount/firstvisit-password"
ssh-keygen -q -t ed25519 -N '' -C lab-host -f "$dir/mount/host_ed"
ssh-keygen -q -t rsa -b 3072 -N '' -C lab-host -f "$dir/mount/host_rsa"
ssh-keygen -q -t ed25519 -N '' -C lab-user -f "$dir/user"
cp "$dir/user.pub" "$dir/mount/authorized_keys"
cp "$dir/mount/host_ed.pub" "$dir/mount/host_rsa.pub" "$dir/"

unpinned=0
port=2200
: > "$dir/boxes"
while read -r name image tool kex; do
  case "$name" in ''|'#'*) continue ;; esac
  if [[ "$image" == *@sha256:unpinned ]]; then
    tag="${image%@*}"
    if docker pull -q "$tag" >/dev/null 2>&1 </dev/null; then
      digest="$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
      version="$(docker run --rm "$tag" sh -c "$(install_cmd "$tool") ; sshd -V 2>&1 | grep -o 'OpenSSH_[^ ,]*' | head -1" 2>&1 </dev/null | tail -1)"
      echo "lab-openssh: NOT PINNED: $name $tag is $digest today, with: $version"
    else
      echo "lab-openssh: NOT PINNED: $name $tag cannot be pulled"
    fi
    unpinned=1
    continue
  fi
  [ "$name" = survey ] && continue
  port=$((port + 10))
  # A real config file, written inside the container, rather than -f /dev/null and a line of -o options.
  # The reason is the file subsystem: sshd has no built-in Subsystem, so with no config at all every one of
  # these servers refused sftp, and every file-protocol test against a real box had been failing since this
  # lab was built. internal-sftp is used so no path has to be guessed per image.
  common="-f /etc/lab/sshd_config -e"
  # A fourth server, and the only one in this lab that takes a password: the first visit of decision O2 is the
  # one place Berth ever offers one, so it is proved against a real OpenSSH rather than against our own box.
  # Its account is made inside the container with a known password, and its authorized_keys is writable, which
  # is the whole point: the visit has to put a key in it.
  withpw="-f /etc/lab/sshd_config_pw -e"
  docker run -d --label berth-lab --name "berth-lab-$name" -v "$dir/mount:/lab:ro" \
    -p "127.0.0.1:$((port + 1)):2201" -p "127.0.0.1:$((port + 2)):2202" -p "127.0.0.1:$((port + 3)):2203" -p "127.0.0.1:$((port + 4)):2204" \
    "$image" sh -c "$(install_cmd "$tool") && mkdir -p /run/sshd /etc/lab && cp /lab/host_ed /lab/host_rsa /etc/lab/ && chmod 600 /etc/lab/host_* \
      && (sshd -V 2>&1 | grep -o 'OpenSSH_[^ ,]*' | head -1) > /version; \
      printf '%s\n' 'PidFile none' 'AuthorizedKeysFile /lab/authorized_keys' 'StrictModes no' 'PasswordAuthentication no' \
        'KbdInteractiveAuthentication no' 'PermitRootLogin no' 'Subsystem sftp internal-sftp' > /etc/lab/sshd_config; \
      printf '%s\n' 'PidFile none' 'StrictModes no' 'PasswordAuthentication yes' 'KbdInteractiveAuthentication no' \
        'PermitRootLogin no' 'Subsystem sftp internal-sftp' > /etc/lab/sshd_config_pw; \
      (useradd -m -s /bin/sh firstvisit 2>/dev/null || adduser -D -s /bin/sh firstvisit 2>/dev/null || true); \
      chpasswd < /lab/firstvisit-password; \
      /usr/sbin/sshd -D -p 2201 -o HostKey=/etc/lab/host_ed $common & \
      /usr/sbin/sshd -D -p 2202 -o HostKey=/etc/lab/host_rsa $common & \
      /usr/sbin/sshd -D -p 2203 -o HostKey=/etc/lab/host_ed -o Ciphers=chacha20-poly1305@openssh.com $common & \
      /usr/sbin/sshd -D -p 2204 -o HostKey=/etc/lab/host_ed $withpw & \
      wait" >/dev/null </dev/null
  echo "$name 127.0.0.1:$((port + 1)) 127.0.0.1:$((port + 2)) 127.0.0.1:$((port + 3)) $kex 127.0.0.1:$((port + 4))" >> "$dir/boxes.pending"
done < toolchain/lab-images
[ "$unpinned" = 0 ] || { echo "lab-openssh: pin the lines above in toolchain/lab-images" >&2; down; exit 1; }

# Wait until every server says its first line, then note which OpenSSH it is.
while read -r name a b c kex pw; do
  for addr in "$a" "$b" "$c" "$pw"; do
    ok=0
    for _ in $(seq 1 120); do
      if (exec 3<>"/dev/tcp/${addr%:*}/${addr#*:}" && head -c 4 <&3 | grep -q SSH-) 2>/dev/null; then ok=1; break; fi
      sleep 1
    done
    [ "$ok" = 1 ] || { echo "lab-openssh: $name at $addr never answered" >&2; docker logs "berth-lab-$name" 2>&1 | tail -20 >&2; exit 1; }
  done
  version="$(docker exec "berth-lab-$name" cat /version | tr -d '\r' | tr ' ' '_')"
  echo "$name $a $b $c $kex $version $pw" >> "$dir/boxes"
  echo "lab-openssh: $name is up: $version"
done < "$dir/boxes.pending"
rm -f "$dir/boxes.pending"
oldest="$(awk '$1=="oldest"{print $6}' "$dir/boxes")"
[[ "$oldest" == OpenSSH_8.9* ]] || { echo "lab-openssh: the oldest server is $oldest, not OpenSSH 8.9" >&2; exit 1; }
chmod -R a+rX "$dir"
