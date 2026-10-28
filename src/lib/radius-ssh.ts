/**
 * RHEL FreeRADIUS Automated SSH & RFC 5176 CoA Client
 * Connects securely to the Red Hat FreeRADIUS AAA server or simulates execution in DRY_RUN mode.
 */

import { Client } from 'ssh2';

export interface ProvisionOptions {
  username: string;
  rateLimit: string;
  vlanId: number;
  nasIp?: string;
  nasSecret?: string;
}

export interface ProvisionResult {
  success: boolean;
  dryRun: boolean;
  output: string;
  commandExecuted?: string;
  logs: string[];
  durationMs: number;
}

// Regex validation rules for strict command-injection prevention
const USERNAME_REGEX = /^[a-zA-Z0-9_:-]+$/;
const RATE_LIMIT_REGEX = /^[0-9]+[kKmMgG]\/[0-9]+[kKmMgG]$/;

export async function provisionRadiusSubscriber({
  username,
  rateLimit,
  vlanId,
  nasIp = process.env.RADIUS_NAS_IP || '10.10.10.1',
  nasSecret = process.env.RADIUS_NAS_SECRET || 'testing123',
}: ProvisionOptions): Promise<ProvisionResult> {
  const startTime = Date.now();

  // 1. Strict validation
  if (!USERNAME_REGEX.test(username)) {
    throw new Error(
      `Invalid username '${username}'. Allowed pattern: ${USERNAME_REGEX}`
    );
  }

  if (!RATE_LIMIT_REGEX.test(rateLimit)) {
    throw new Error(
      `Invalid rate limit '${rateLimit}'. Allowed pattern: ${RATE_LIMIT_REGEX}`
    );
  }

  if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094) {
    throw new Error(
      `Invalid VLAN ID '${vlanId}'. Must be integer between 1 and 4094.`
    );
  }

  const isDryRun = process.env.RADIUS_DRY_RUN === 'true' || !process.env.RHEL_RADIUS_HOST;

  // 2. DRY-RUN Simulation fallback
  if (isDryRun) {
    // Simulate real SSH round-trip latency & CoA UDP exchange (600ms)
    await new Promise((resolve) => setTimeout(resolve, 600));

    const simulatedLogs = [
      `[SSH] Connected to svc_radius@${process.env.RHEL_RADIUS_HOST || '192.168.10.25'}:22`,
      `[EXEC] sudo /usr/local/bin/provision_subscriber.sh "${username}" "${rateLimit}" "${vlanId}" "${nasIp}" "***"`,
      `[RHEL] Backing up /etc/raddb/mods-config/files/authorize`,
      `[RHEL] Updated Mikrotik-Rate-Limit = "${rateLimit}", Tunnel-Private-Group-Id = "${vlanId}"`,
      `[RHEL] Reloading FreeRADIUS daemon (systemctl reload radiusd)... [OK]`,
      `[CoA] Sent RFC 5176 CoA-Request (Code 43) to NAS ${nasIp}:3799`,
      `[CoA] Received CoA-ACK (Code 44) from NAS ${nasIp}`,
      `[EXIT] PROVISION_OK`,
    ];

    return {
      success: true,
      dryRun: true,
      output: 'PROVISION_OK',
      commandExecuted: `/usr/local/bin/provision_subscriber.sh "${username}" "${rateLimit}" "${vlanId}"`,
      logs: simulatedLogs,
      durationMs: Date.now() - startTime,
    };
  }

  // 3. Live SSH Execution to RHEL FreeRADIUS Host
  const host = process.env.RHEL_RADIUS_HOST!;
  const port = Number(process.env.RHEL_RADIUS_PORT) || 22;
  const rhelUser = process.env.RHEL_RADIUS_USER || 'svc_radius';
  const privateKey = process.env.RHEL_RADIUS_SSH_KEY;
  const password = process.env.RHEL_RADIUS_PASSWORD;

  const command = `sudo /usr/local/bin/provision_subscriber.sh "${username}" "${rateLimit}" "${vlanId}" "${nasIp}" "${nasSecret}"`;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    const logs: string[] = [
      `[SSH] Initiating connection to ${rhelUser}@${host}:${port}...`,
    ];
    let stdoutBuffer = '';
    let stderrBuffer = '';

    conn
      .on('ready', () => {
        logs.push(`[SSH] Authenticated successfully as ${rhelUser}`);
        logs.push(`[SSH] Executing: ${command.replace(nasSecret, '***')}`);

        conn.exec(command, (err, stream) => {
          if (err) {
            conn.end();
            return reject(new Error(`SSH Exec initialization failed: ${err.message}`));
          }

          stream
            .on('close', (code: number) => {
              conn.end();
              const durationMs = Date.now() - startTime;
              logs.push(`[SSH] Process exited with code ${code}`);

              const isSuccess = code === 0 && stdoutBuffer.includes('PROVISION_OK');

              if (!isSuccess) {
                return reject(
                  new Error(
                    `FreeRADIUS Provisioning failed (exit code ${code}): ${stderrBuffer || stdoutBuffer}`
                  )
                );
              }

              resolve({
                success: true,
                dryRun: false,
                output: stdoutBuffer.trim(),
                commandExecuted: command.replace(nasSecret, '***'),
                logs,
                durationMs,
              });
            })
            .on('data', (data: Buffer) => {
              stdoutBuffer += data.toString();
              data
                .toString()
                .split('\n')
                .filter(Boolean)
                .forEach((line) => logs.push(`[STDOUT] ${line}`));
            })
            .stderr.on('data', (data: Buffer) => {
              stderrBuffer += data.toString();
              data
                .toString()
                .split('\n')
                .filter(Boolean)
                .forEach((line) => logs.push(`[STDERR] ${line}`));
            });
        });
      })
      .on('error', (err) => {
        logs.push(`[SSH-ERROR] ${err.message}`);
        reject(new Error(`SSH Connection error to FreeRADIUS VM (${host}): ${err.message}`));
      })
      .connect({
        host,
        port,
        username: rhelUser,
        privateKey,
        password,
        readyTimeout: 10000,
      });
  });
}
