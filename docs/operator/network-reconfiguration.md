# Move an agent to a different Wi-Fi network

Generated Agent Boot images preserve a local recovery login on tty2 while the runner uses tty1.
The recovery path, profile writer, and private Node runtime are already on the image and do not
need internet access.

1. Connect a keyboard and display, then press `Ctrl`+`Alt`+`F2` to open tty2.
2. Log in with the local account created when the image was prepared.
3. Inspect association state without root access:

   ```console
   agent-boot-network status
   ```

4. Configure the new network and apply it:

   ```console
   sudo agent-boot-network configure
   ```

   Enter the SSID at the first prompt and the Wi-Fi password at the hidden second prompt. The
   password is not a command-line argument and is not echoed. Do not place it in shell history,
   logs, issues, pull requests, or notes.

For an operator workflow that already knows the non-secret SSID, use:

```console
sudo agent-boot-network set-wifi --ssid 'network name' --ask-pass
```

The command atomically replaces
`/etc/NetworkManager/system-connections/agent-boot-wifi.nmconnection` as a root-owned `0600`
profile, reloads NetworkManager connections, and activates the fixed `wlan0` connection. It emits
only constant success or error codes. It never accepts a password option or password environment
variable.

If NetworkManager itself needs to be restarted, run:

```console
sudo agent-boot-network restart
agent-boot-network status
```

The network commands do not delete, reset, or rewrite `/var/lib/agent-boot/state.json`. A reboot
after reconfiguration resumes the existing runner checkpoint instead of replaying completed steps
or prompts. Return to tty1 with `Ctrl`+`Alt`+`F1` to follow runner progress. When association is
unavailable, tty1 also prints the recovery action for tty2.
