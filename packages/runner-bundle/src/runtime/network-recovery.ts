import { SystemNetwork } from "../network/system-network.js";

export const NETWORK_RECOVERY_GUIDANCE =
  'agent-boot: status=network-unavailable recovery=login-tty2 command="sudo agent-boot-network configure"\n';

export const networkRecoveryGuidance = async (
  network: Pick<SystemNetwork, "association"> = new SystemNetwork(),
): Promise<string> =>
  await network.association() === "connected" ? "" : NETWORK_RECOVERY_GUIDANCE;
