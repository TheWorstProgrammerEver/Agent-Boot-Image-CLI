# SSH key promotion

Agent Boot can prepare an image with temporary password SSH so the first
operator can reach a headless Raspberry Pi. Treat that password as a bootstrap
credential only. Promote the host to public-key SSH before relying on it for
ongoing unattended agent work, then disable password authentication.

Use this runbook after the image has booted, networking is reachable, and the
agent account exists. Keep at least one recovery console or already-authenticated
SSH session open until the public-key-only validation succeeds.

## 1. Install a workstation public key

From the workstation, install the public key using the temporary password. The
command is safe to repeat without adding the same key twice:

```console
ssh my-user@my-agent.local '
  umask 077
  mkdir -p ~/.ssh
  touch ~/.ssh/authorized_keys
  chmod 700 ~/.ssh
  chmod 600 ~/.ssh/authorized_keys
  IFS= read -r key
  test -n "$key" || exit 1
  grep -qxF "$key" ~/.ssh/authorized_keys ||
    printf "%s\n" "$key" >> ~/.ssh/authorized_keys
' < ~/.ssh/id_ed25519.pub
```

Use the actual public key path for the operator workstation. Never copy a
private key to the agent. The remaining examples assume its corresponding
private key is `~/.ssh/id_ed25519`.

## 2. Validate key-only login

Open a second terminal and force public-key authentication:

```console
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o PasswordAuthentication=no my-user@my-agent.local 'id -un && hostname'
```

Continue only if this command succeeds and prints the expected user and host.
If mDNS is not available, use the LAN address for the same agent.

## 3. Disable password SSH

From an existing agent session, install a small sshd drop-in that disables
password authentication while leaving public-key login enabled:

```console
sudo tee /etc/ssh/sshd_config.d/00-agent-boot-key-only.conf >/dev/null <<'EOF'
PermitRootLogin no
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
sudo sshd -t
sudo sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
```

The effective configuration must contain all four values below, regardless of
output order:

```text
permitrootlogin no
pubkeyauthentication yes
passwordauthentication no
kbdinteractiveauthentication no
```

Do not reload SSH if any value differs. OpenSSH uses the first value it obtains
for each setting, so the `00-` prefix deliberately places this override before
Agent Boot's generated `20-agent-boot.conf`.

Reload SSH only after both checks pass:

```console
sudo systemctl reload ssh.service
```

This changes remote SSH authentication only. It preserves the account password
for the local tty2 recovery login. Do not close the existing session yet.

## 4. Revalidate from the workstation

Confirm key login still works:

```console
ssh -i ~/.ssh/id_ed25519 -o IdentitiesOnly=yes -o PreferredAuthentications=publickey -o PasswordAuthentication=no my-user@my-agent.local 'id -un && hostname'
```

Confirm password login is no longer offered:

```console
ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no -o KbdInteractiveAuthentication=no -o NumberOfPasswordPrompts=1 my-user@my-agent.local true
```

The password-only command should fail. If it succeeds, inspect the effective
sshd configuration before continuing:

```console
sudo sshd -T | grep -E '^(permitrootlogin|pubkeyauthentication|passwordauthentication|kbdinteractiveauthentication) '
```

## Optional definition placement

For reusable images, model this as an explicit manual checkpoint before
`codex.bootstrapSteps` when the agent should not install or authenticate Codex
while password SSH remains available. The completion probe should verify that
`PasswordAuthentication no` is effective and that at least one authorized
public key exists. Agent Boot should still treat the key material as
operator-owned input; private keys do not belong in definitions, prompts,
artifacts, or prepared images.
