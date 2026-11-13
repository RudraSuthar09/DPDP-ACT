# DPDP production — single server on AWS (Sydney)

One EC2 server in **Asia Pacific (Sydney), `ap-southeast-2`**, running the whole
platform with Docker Compose:

```
Internet ─► Caddy :80/:443 (automatic HTTPS) ─► https://app.hhgoa.work ─► frontend (Next.js)
                                              └► https://api.hhgoa.work ─► backend (NestJS API) ─► PostgreSQL 16
                                                                           worker (NestJS, one) ──┘
Customer machines: DPDP Gateway ─► https://api.hhgoa.work
```

| File                                        | Purpose                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `deploy/single-server/terraform/`           | Server, firewall, Elastic IP, Route 53 zone + records, daily disk snapshots                        |
| `deploy/single-server/iam/`                 | Least-privilege IAM policies: 2 for deploying, 1 (never attached by default) for teardown/recovery |
| `docker-compose.prod.yml` (repository root) | The production stack                                                                               |
| `deploy/single-server/Caddyfile`            | HTTPS and routing by host name                                                                     |
| `deploy/single-server/generate-env.sh`      | Creates `.env.prod` (all secrets) on the server, once                                              |

Every command is labelled with **where** it runs:

- **WINDOWS POWERSHELL** — on your PC, in `E:\DPDP ACT\DPDP-ACT` unless stated
- **UBUNTU EC2 SERVER** — on the server, over SSH, in `~/dpdp` unless stated
- **AWS CONSOLE** — https://console.aws.amazon.com (region **Asia Pacific (Sydney)**)
- **NAMECHEAP DASHBOARD** — https://ap.www.namecheap.com

Nothing here is applied automatically. You run every step yourself, after
reviewing the Terraform plan.

---

## 1. Cost and server size

### Prices (confirmed)

From AWS's official public price files for `ap-southeast-2`, retrieved
2026-11-13 (on-demand, Linux, USD, before tax):

| Item                                             | Price                                                 |
| ------------------------------------------------ | ----------------------------------------------------- |
| t3a.small (2 vCPU, 2 GiB)                        | $0.0238 / hour                                        |
| t3.small (2 vCPU, 2 GiB)                         | $0.0264 / hour                                        |
| t3a.medium (2 vCPU, 4 GiB)                       | $0.0475 / hour                                        |
| t3.medium (2 vCPU, 4 GiB)                        | $0.0528 / hour                                        |
| EBS gp3 storage (3,000 IOPS / 125 MB/s incl.)    | $0.096 / GB-month                                     |
| EBS snapshot storage                             | $0.055 / GB-month                                     |
| Public IPv4 address (Elastic IP, in use or idle) | $0.005 / hour                                         |
| Route 53 hosted zone                             | $0.50 / month                                         |
| Route 53 standard DNS queries                    | $0.40 / million                                       |
| Data transfer out to the internet                | first 100 GB/month free (all regions), then $0.114/GB |

### Monthly estimate (730 hours)

| Item                           | **B. Budget (default)** t3a.small, 20 GB | **A. Recommended** t3a.medium, 30 GB |
| ------------------------------ | ---------------------------------------- | ------------------------------------ |
| EC2 compute                    | $17.37                                   | $34.67                               |
| EBS gp3 disk                   | $1.92                                    | $2.88                                |
| Public IPv4 (Elastic IP)       | $3.65                                    | $3.65                                |
| Route 53 zone + queries        | $0.50 + < $0.01                          | $0.50 + < $0.01                      |
| Snapshots (7 daily) — estimate | ≈ $0.50–1.50                             | ≈ $0.70–2.00                         |
| Data transfer out — estimate   | $0 (under 100 GB/month)                  | $0 (under 100 GB/month)              |
| **Total before tax**           | **≈ $24–25**                             | **≈ $42–44**                         |
| With 18% GST (see below)       | ≈ $28–30                                 | ≈ $50–52                             |

Assumptions (estimates, not confirmed): the server runs all month; snapshot
storage = one full copy of the used blocks (≈ 6–10 GB) plus daily changes;
fewer than 100 GB/month leaves AWS. The t3 "standard" CPU-credit mode used here
never adds surplus-credit charges (the CPU slows down instead). Nothing else
is billable here: no load balancer, NAT gateway, managed database or paid
monitoring.

**Tax:** if your AWS account is billed by AWS's Indian entity (AISPL — an
Indian billing address), 18% GST is added to these amounts. Check an invoice.

**Your $30 budget:** only configuration **B** fits. **A is the recommended size
for production** (4 GiB: about twice the headroom for growth, bursts and more users) but
costs ≈ $42–44 before tax. It is _not_ the default; choose it only by
approving the higher budget (set `instance_type = "t3a.medium"` and
`root_volume_gb = 30`). Moving from B to A later is an in-place change
(a few minutes of downtime, no data loss); the disk can grow but never shrink.

**Why not smaller/cheaper:** t3.micro/t3a.micro (1 GiB) cannot hold this
stack (measurements below). Graviton (t4g, ~10% cheaper) needs ARM images,
which this project does not build; Terraform refuses non-x86_64 types.

### Can 2 GiB run this stack? (measured)

Measured on 2026-11-13 by running the real compiled processes in production
mode against a local PostgreSQL (Windows working-set figures; Linux
containers are typically similar or slightly lower):

| Process (production mode)              | Measured, light load                  | Planning figure on the server                    |
| -------------------------------------- | ------------------------------------- | ------------------------------------------------ |
| API (NestJS, `dist/main.js`)           | 88 MB private memory                  | 150–250 MB                                       |
| Worker (NestJS, `dist/worker.js`)      | 56 MB private memory                  | 80–150 MB                                        |
| Frontend (`next start`)                | 120 MB working set                    | 150–250 MB                                       |
| PostgreSQL 16                          | 52–216 MB (Windows accounting varies) | 150–300 MB (128 MB shared buffers + connections) |
| Caddy                                  | not measured                          | 30–60 MB                                         |
| Ubuntu + Docker Engine                 | not measured                          | 350–450 MB                                       |
| **Running total**                      |                                       | **≈ 0.9–1.5 GB of 2 GiB**                        |
| **Next.js production build** (one-off) | **peak 2.9 GB**, 222 s on the PC      | does not fit a 2 GiB server                      |

"Light load" = start-up plus a burst of health checks and page loads; real
use grows the Node heaps, hence the planning figures. Conclusion: **2 GiB
runs the stack**, with the 2 GB swap file as a buffer for spikes, **but cannot
build the frontend** — so images are built on your PC (step 7) in both
configurations. 1 GiB (t3.micro) would leave nothing for the OS and swap
constantly: not viable.

### Limitations of configuration B (budget)

- **Build the images on your PC**, not on the server (step 7). A Next.js
  production build on a 2 GiB server would push it deep into swap and slow
  the running platform; on a burstable CPU it can also use up the CPU credits.
- **Burstable CPU (standard credits):** sustained high CPU (heavy imports,
  bulk exports, many simultaneous users) is throttled to the baseline (20% of
  each vCPU for t3a.small) once credits run out. Fine for ~10 early clients
  with ordinary use; watch `CPUCreditBalance` in CloudWatch.
- **Small memory margin:** a traffic spike or a memory leak goes into swap
  (slower) rather than failing; a sustained shortage can make the kernel stop
  a container (Docker restarts it).
- **One server, one Availability Zone:** if the server fails, the platform is
  down until it is restored (section 16). Same for configuration A.

**AWS Budgets** (step 2) only **alerts** you; it never stops resources or caps
spending.

---

## 2. Create the deployment identity (once)

Terraform needs an AWS identity. Do **not** use the root account's access keys
or `AdministratorAccess` for routine deployments. Use a dedicated IAM user with
the least-privilege policies in `deploy/single-server/iam/`:

| File                                         | Console name                | Attach to `dpdp-deployer`?                      | Allows                                                                                                                                                                                                                                             |
| -------------------------------------------- | --------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `terraform-deployer-ec2-policy.json`         | `dpdp-deployer-ec2`         | **yes**                                         | Create/update the server, its disk, security group, key pair and Elastic IP — only resources tagged `Project=dpdp`, only in `ap-southeast-2`, only Canonical Ubuntu images. No terminate, delete or release.                                       |
| `terraform-deployer-dns-iam-dlm-policy.json` | `dpdp-deployer-dns-iam-dlm` | **yes**                                         | Create the Route 53 zone; create/update only the `app`/`api` A records; manage only the `dpdp-server-snapshots` role (attach only AWS's DLM policy, pass it only to DLM); manage the snapshot schedule; decode access-denied messages. No deletes. |
| `terraform-teardown-recovery-policy.json`    | `dpdp-teardown-recovery`    | **no** — only temporarily (sections 15, 16, 18) | Destroy the server, IP, security group, key pair, DNS records/zone, role and schedule; manual snapshots and root-volume replacement.                                                                                                               |

The deployer permissions are split over two policies because one AWS managed
policy may hold at most 6,144 characters. They hard-code what this Terraform
creates: region `ap-southeast-2`, tag `Project=dpdp`, key pair
`dpdp-server-ssh`, role `dpdp-server-snapshots`, records `app.hhgoa.work` and
`api.hhgoa.work`. If you change `aws_region`, `project`, `domain_name` or the
subdomains, change the policies too.

The files contain the placeholder `<AWS_ACCOUNT_ID>`. AWS rejects them until it
is replaced with your 12-digit account ID (**AWS CONSOLE** → account menu, top
right → _Account ID_).

**AWS CONSOLE** (signed in as the root user or an administrator — this once):

1. Region selector → **Asia Pacific (Sydney)**.
2. For **each** of the three files: prepare it with your account ID —
   **WINDOWS POWERSHELL** (copies the result to the clipboard; writes no file):

   ```powershell
   $acct = "123456789012"   # <- your 12-digit account ID
   if ($acct -notmatch '^\d{12}$') { throw 'Account ID must be exactly 12 digits' }
   (Get-Content deploy\single-server\iam\terraform-deployer-ec2-policy.json -Raw).Replace('<AWS_ACCOUNT_ID>', $acct) | Set-Clipboard
   ```

   then **IAM → Policies → Create policy → JSON**, replace the editor content
   with the clipboard. The editor checks the policy as you paste: it must show
   **no errors and no security warnings**. Next → name it as in the table →
   **Create policy**. Repeat for `terraform-deployer-dns-iam-dlm-policy.json` and
   `terraform-teardown-recovery-policy.json` (change the file name in the last line).

3. **IAM → Users → Create user** → name `dpdp-deployer` → do **not** enable
   console access → Next → **Attach policies directly** → tick
   `dpdp-deployer-ec2` and `dpdp-deployer-dns-iam-dlm` (**not**
   `dpdp-teardown-recovery`) → Create user.
4. Open `dpdp-deployer` → **Security credentials → Create access key** → use
   case **Command Line Interface (CLI)** → confirm → Create. Keep this page open
   for the next step; the secret is shown **once**. Never put it in a file in
   the repository, a chat or an e-mail.
5. **Billing → Budgets → Create budget → Monthly cost budget** → amount `30` →
   your e-mail. (An alert only — see section 1.)

**Using the teardown/recovery policy** (only for sections 15 "Replacing your SSH
key", 16 option 2 and 18): **AWS CONSOLE → IAM → Users → dpdp-deployer → Add
permissions → Attach policies directly → `dpdp-teardown-recovery`**; do the task;
then **remove it again** in the user's _Permissions_ tab.

**If a command fails with `AccessDenied` / `UnauthorizedOperation`:** the message
names the action. If it also contains `Encoded authorization failure message`,
decode it — **WINDOWS POWERSHELL**:
`aws sts decode-authorization-message --encoded-message <the long text> --query DecodedMessage --output text`.
It shows which resource and condition did not match. Do not widen the policy
to `"*"`: fix the cause (wrong region, missing `Project=dpdp` tag, different
name) or add only the named action, scoped like its neighbours.

**WINDOWS POWERSHELL** — store the key in a named AWS CLI profile (typed at the
prompts, not on the command line):

```powershell
aws configure --profile dpdp-deploy
#   AWS Access Key ID:      <from step 4>
#   AWS Secret Access Key:  <from step 4>
#   Default region name:    ap-southeast-2
#   Default output format:  json
$env:AWS_PROFILE = "dpdp-deploy"     # every later command in this window uses it
aws sts get-caller-identity          # Arn must end in user/dpdp-deployer
```

`$env:AWS_PROFILE` lasts for this PowerShell window only: set it again in each
new window. Rotate the access key every few months (IAM → user → Security
credentials) and delete it when you no longer deploy. (IAM Identity Center
with short-lived credentials is stronger still, but needs more setup.)

---

## 3. Pre-flight checks (read-only)

**WINDOWS POWERSHELL** (with `$env:AWS_PROFILE = "dpdp-deploy"`):

```powershell
# a) The account has a default VPC in Sydney (must print a vpc-... id)
aws ec2 describe-vpcs --region ap-southeast-2 --filters Name=isDefault,Values=true --query "Vpcs[].VpcId" --output text

# b) Which Sydney zones offer the instance type (ap-southeast-2a should be listed)
aws ec2 describe-instance-type-offerings --region ap-southeast-2 --location-type availability-zone --filters Name=instance-type,Values=t3a.small --query "InstanceTypeOfferings[].Location" --output text

# c) The Ubuntu 24.04 image Terraform will pick (must print an ami-... id and name)
aws ec2 describe-images --region ap-southeast-2 --owners 099720109477 --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" "Name=state,Values=available" --query "sort_by(Images,&CreationDate)[-1].[ImageId,Name]" --output text

# d) Is there ALREADY a Route 53 zone for the domain? (see below)
aws route53 list-hosted-zones-by-name --dns-name hhgoa.work --query "HostedZones[?Name=='hhgoa.work.'].[Id,Config.PrivateZone]" --output text

# e) Your current public IPv4 address (for SSH)
$myIp = (Invoke-RestMethod https://checkip.amazonaws.com).Trim(); "$myIp/32"
```

- If (a) prints nothing: the default VPC was deleted. Recreate it in **AWS
  CONSOLE → VPC → Your VPCs → Actions → Create default VPC**.
- If (b) does not list `ap-southeast-2a`: set `availability_zone` to a zone it
  lists (step 5).
- **(d) is the duplicate-zone check.** If it prints a line like
  `/hostedzone/Z0123ABC  False`, a public zone already exists: put
  `existing_hosted_zone_id = "Z0123ABC"` in `terraform.tfvars` so Terraform uses
  it instead of creating a second zone (two zones have different nameservers —
  only the one Namecheap points at would work). Nothing prints = no zone yet;
  Terraform creates it. Never delete a zone to "fix" a duplicate without first
  checking which one Namecheap uses.

---

## 4. Inventory the domain's current DNS (before anything changes)

When Namecheap is switched to Route 53 (step 9), **every record kept at
Namecheap stops working**. Copy any you need into Route 53 first.

**NAMECHEAP DASHBOARD** → Domain List → **Manage** (hhgoa.work):

1. **Advanced DNS → Host Records** and **Mail Settings**: write down every
   record — especially **MX** (e-mail), **TXT** (SPF `v=spf1 …`, DKIM, DMARC
   `_dmarc`, site verifications), **CNAME**, **A/AAAA**, **SRV**. If Mail
   Settings shows **Email Forwarding**, it depends on Namecheap's DNS and stops
   after the switch — recreate its MX/TXT records in Route 53 or use another
   mail provider.
2. **DNSSEC** (Advanced DNS): if enabled, **turn it off** now and wait 24 hours
   before step 9. Leaving it on while the nameservers move makes the domain
   fail to resolve for validating resolvers. (Route 53 DNSSEC can be enabled
   later; it is not set up here.)

**WINDOWS POWERSHELL** — what the internet currently sees (keep the output):

```powershell
foreach ($t in 'NS','MX','TXT','A','CNAME') { Resolve-DnsName hhgoa.work -Type $t -Server 8.8.8.8 -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String -Width 200 }
Resolve-DnsName _dmarc.hhgoa.work -Type TXT -Server 8.8.8.8 -ErrorAction SilentlyContinue | Format-Table -AutoSize | Out-String -Width 200
```

---

## 5. Configure and run Terraform

**WINDOWS POWERSHELL:**

```powershell
Copy-Item deploy\single-server\terraform\terraform.tfvars.example deploy\single-server\terraform\terraform.tfvars
notepad deploy\single-server\terraform\terraform.tfvars
```

Set `ssh_allowed_cidr` to your `"<ip>/32"` from step 3(e), and
`existing_hosted_zone_id` only if step 3(d) found a zone. Keep the rest.

```powershell
$env:AWS_PROFILE = "dpdp-deploy"
terraform -chdir=deploy/single-server/terraform init
terraform -chdir=deploy/single-server/terraform validate
terraform -chdir=deploy/single-server/terraform plan -out tfplan
```

### Terraform plan review checklist

Read the whole plan before applying. For a **first** deployment it must say
`Plan: 10 to add, 0 to change, 0 to destroy.` (9 if you set
`existing_hosted_zone_id`):

- [ ] `aws_key_pair.server`, `aws_security_group.server`, `aws_instance.server`,
      `aws_eip.server`, `aws_route53_zone.main[0]` (unless adopting a zone),
      `aws_route53_record.app`, `aws_route53_record.api`, `aws_iam_role.dlm`,
      `aws_iam_role_policy_attachment.dlm`, `aws_dlm_lifecycle_policy.daily`.
- [ ] **Nothing to destroy.** On any later plan, `destroy` or
      `must be replaced` next to `aws_instance.server` means STOP — that would
      delete the database (Terraform also refuses it: `prevent_destroy`).
- [ ] `aws_instance.server`: `instance_type` as intended, `availability_zone`
      `ap-southeast-2a` (or yours), `disable_api_termination = true`,
      `metadata_options.http_tokens = "required"`,
      `root_block_device.encrypted = true`, volume tag `Backup = "dpdp-daily"`.
- [ ] `aws_security_group.server`: port 22 only from **your** `/32`; 80 and 443
      (TCP) and 443 (UDP) from `0.0.0.0/0`; nothing else inbound.
- [ ] `aws_dlm_lifecycle_policy.daily`: `times = ["20:30"]`, `count = 7`,
      `target_tags = { Backup = "dpdp-daily" }`.
- [ ] Region is Sydney: availability zones and ARNs show `ap-southeast-2`.

Then:

```powershell
terraform -chdir=deploy/single-server/terraform apply tfplan
terraform -chdir=deploy/single-server/terraform output
```

The server installs Docker by itself in the next ~3–5 minutes. Note
`route53_nameservers`, `server_ip` and `ssh_command`.

**Back up the Terraform state now and after every apply** (it holds no
passwords for this configuration, but Terraform needs it to manage the server):

```powershell
New-Item -ItemType Directory -Force $env:USERPROFILE\dpdp-backups | Out-Null
Copy-Item deploy\single-server\terraform\terraform.tfstate "$env:USERPROFILE\dpdp-backups\terraform.tfstate.$(Get-Date -Format yyyyMMdd-HHmm)"
```

---

## 6. Recreate kept DNS records in Route 53 (if step 4 found any)

**AWS CONSOLE → Route 53 → Hosted zones → hhgoa.work → Create record**, one per
record from step 4 (same name, type, value, TTL). Do **not** create `app` or
`api` — Terraform owns those. Do this **before** step 9 so mail and
verifications keep working through the switch.

---

## 7. Build the images on your PC

**WINDOWS POWERSHELL** (Docker Desktop **running**; from the repository root):

```powershell
docker build --platform linux/amd64 -f backend/Dockerfile -t dpdp-backend:prod .
docker build --platform linux/amd64 -f frontend/Dockerfile --build-arg NEXT_PUBLIC_API_URL=https://api.hhgoa.work -t dpdp-frontend:prod .
docker save -o "$env:USERPROFILE\dpdp-images.tar" dpdp-backend:prod dpdp-frontend:prod
```

- `NEXT_PUBLIC_API_URL` is baked into the frontend image: it **must** be
  `https://api.hhgoa.work`.
- `docker compose ... build` cannot be used on the PC: Compose requires
  `.env.prod`, which exists only on the server (on purpose).
- Build on the PC in configuration A too: the frontend build alone peaks at
  about 2.9 GB of memory (section 1), too much next to the running stack.

---

## 8. Log in to the server

**WINDOWS POWERSHELL** (use `server_ip` from step 5; your private key stays on your PC):

```powershell
$ip = terraform -chdir=deploy/single-server/terraform output -raw server_ip
ssh -i "$env:USERPROFILE\.ssh\dpdp_key" ubuntu@$ip
```

Answer `yes` to the host-key question once. (`$ip` is used again in steps 10, 11 and 15: in a new PowerShell window, run the `$ip = ...` line again.) **UBUNTU EC2 SERVER:**

```bash
cloud-init status --wait          # "status: done" when first-boot setup finished
docker version && docker compose version
swapon --show && free -h          # 2G swap file present
```

If `docker` says _permission denied_: `exit`, log in again, retry.
If SSH times out: your IP changed — see section 15 "Your IP address changed".

---

## 9. Switch Namecheap to Route 53

**NAMECHEAP DASHBOARD** → Domain List → **Manage** (hhgoa.work) →
**Nameservers** → **Custom DNS** → enter the **4** values from
`route53_nameservers` (one per line, no trailing dot) → green ✓.

Then wait (usually 10–60 minutes, up to 48 hours). **WINDOWS POWERSHELL:**

```powershell
Resolve-DnsName hhgoa.work -Type NS -Server 8.8.8.8 | Select-Object -ExpandProperty NameHost
Resolve-DnsName app.hhgoa.work -Type A -Server 8.8.8.8
Resolve-DnsName api.hhgoa.work -Type A -Server 1.1.1.1
```

Continue to step 13 (starting Caddy) only when the NS lookup shows the four
`awsdns` names **and** both A lookups return `server_ip`. Steps 10–12 can be
done while you wait.

---

## 10. Copy the code and the images to the server

**WINDOWS POWERSHELL** — pack the source (no dependencies, build output, Git
data, secrets, Terraform state or SSH keys) and upload both files:

```powershell
tar.exe -czf "$env:USERPROFILE\dpdp-src.tgz" --exclude=node_modules --exclude=.git --exclude=.next --exclude=dist --exclude=build --exclude=.turbo --exclude=.localdb --exclude=.terraform --exclude='*.tfstate*' --exclude='*.tfvars' --exclude=.env --exclude='.env.*' --exclude=var --exclude=.claude --exclude='$generatedMfaKey*' .
scp -i "$env:USERPROFILE\.ssh\dpdp_key" "$env:USERPROFILE\dpdp-src.tgz" "$env:USERPROFILE\dpdp-images.tar" "ubuntu@${ip}:~/"
```

**UBUNTU EC2 SERVER:**

```bash
mkdir -p ~/dpdp && tar -xzf ~/dpdp-src.tgz -C ~/dpdp && rm ~/dpdp-src.tgz
cd ~/dpdp
# Files edited on Windows can carry CRLF line endings; bash and Caddy need LF.
sed -i 's/\r$//' deploy/single-server/*.sh deploy/single-server/Caddyfile
docker load -i ~/dpdp-images.tar && rm ~/dpdp-images.tar
docker image ls | grep dpdp-       # dpdp-backend:prod and dpdp-frontend:prod
```

---

## 11. Create the secrets file (once)

**UBUNTU EC2 SERVER:**

```bash
cd ~/dpdp
bash deploy/single-server/generate-env.sh
stat -c '%a %U %n' .env.prod                 # must print: 600 ubuntu .env.prod
grep -c $'\r' .env.prod || true               # must print: 0
```

It writes `~/dpdp/.env.prod` with fresh database passwords, the JWT secret and
the two **encryption keys** (`MFA_SECRET_ENC_KEY`, `SUBMISSION_STAGING_ENC_KEY`).
It refuses to overwrite an existing file. Nothing is printed.

**Back it up off the server now** — without it, a restored database cannot be
decrypted. **WINDOWS POWERSHELL:**

```powershell
scp -i "$env:USERPROFILE\.ssh\dpdp_key" "ubuntu@${ip}:~/dpdp/.env.prod" "$env:USERPROFILE\dpdp-backups\env.prod.$(Get-Date -Format yyyyMMdd)"
```

Then store that file in a password manager or other encrypted storage, and
delete the plain copy from your PC. Never e-mail it, put it in the repository,
or upload it unencrypted to cloud storage.

---

## 12. Database: start, create roles, migrate

**UBUNTU EC2 SERVER:**

```bash
cd ~/dpdp
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml run --rm db-bootstrap   # once
docker compose -f docker-compose.prod.yml run --rm migrate
```

Expected:

- `db-bootstrap`: `Created role dpdp_owner.`, `Created role dpdp_app.`, both
  `superuser=false bypassrls=false`, `Database bootstrap complete.`
- `migrate`: `Migrations complete!` and `pg-boss schema installed and up to date.`

Order matters: the API and worker connect as `dpdp_app`/`dpdp_owner`, which do
not exist until `db-bootstrap` has run, and need the tables from `migrate`.

---

## 13. Start everything (only after DNS resolves — step 9)

**UBUNTU EC2 SERVER:**

```bash
cd ~/dpdp
getent ahostsv4 app.hhgoa.work | head -1      # must show this server's IP
getent ahostsv4 api.hhgoa.work | head -1
# Check the Caddyfile with the same Caddy version Compose uses (parses only; no certificates requested)
docker run --rm -v "$PWD/deploy/single-server/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2.8 caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > /dev/null && echo "Caddyfile OK"
docker compose -f docker-compose.prod.yml up -d
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs caddy | grep -i "certificate obtained"
```

Starting Caddy before DNS points here makes its Let's Encrypt requests fail;
after repeated failures Let's Encrypt makes it wait (roughly an hour) before
trying again.

`ps` shows `caddy`, `backend` (healthy), `worker`, `frontend` (healthy) and
`postgres` (healthy) running, and Caddy logs `certificate obtained
successfully` for both names.

---

## 14. Verify

**WINDOWS POWERSHELL:**

```powershell
curl.exe https://api.hhgoa.work/health                      # {"status":"ok",...,"database":"ok"}
curl.exe -sI http://app.hhgoa.work | Select-String Location  # Location: https://app.hhgoa.work/
curl.exe -sI https://api.hhgoa.work/health | Select-String Strict-Transport-Security
Start-Process https://app.hhgoa.work
```

**UBUNTU EC2 SERVER:**

```bash
docker compose -f docker-compose.prod.yml logs worker | grep -i leadership   # "...the only active worker."
docker compose -f docker-compose.prod.yml logs backend | grep -iE "warn|error" | tail -20
```

Expected backend start-up **warnings** (not errors) in this setup: database
connection without TLS (it never leaves the internal Docker network), import
evidence on local disk, no e-mail/SMS provider, job queue on the owner role.

In the browser: create the first workspace (organisation, your name, e-mail,
password of 12+ characters, plan). The **license key is shown once** — keep it.
Enrol MFA with an authenticator app.

**Gateway:** in the DPDP Gateway Setup app on a customer's machine, the
workspace URL is **`https://api.hhgoa.work`**; the one-time code comes from the
web app (Sources & Storage → Enterprise Gateway).

**Backup check (next day):** AWS CONSOLE → EC2 → **Snapshots** — one snapshot
of `dpdp-server-disk`, created around 20:30 UTC / 02:00 IST.

---

## Pre-deployment validation checklist

- [ ] Section 1: configuration chosen (B default; A only with budget approval).
- [ ] Section 2: `aws sts get-caller-identity` shows `user/dpdp-deployer`; budget alert created.
- [ ] Section 3: default VPC, instance type offered in the AZ, Ubuntu AMI found, hosted-zone check done, your `/32` known.
- [ ] Section 4: Namecheap records listed; DNSSEC off; mail records planned.
- [ ] `terraform.tfvars`: `ssh_allowed_cidr` = your IP `/32`; `existing_hosted_zone_id` set only if a zone exists.
- [ ] `terraform validate` OK; plan reviewed against the checklist in section 5; **0 to destroy**.
- [ ] After apply: state backed up; Route 53 extra records created (section 6) before the Namecheap switch.
- [ ] Images built with `NEXT_PUBLIC_API_URL=https://api.hhgoa.work`.
- [ ] `.env.prod`: mode 600, no CR characters, backed up encrypted off the server.
- [ ] DNS resolves to `server_ip` from 8.8.8.8 and 1.1.1.1 before `up -d`.

---

## 15. Everyday operations

**UBUNTU EC2 SERVER** (in `~/dpdp`):

| Task                        | Command                                                     |
| --------------------------- | ----------------------------------------------------------- |
| Status                      | `docker compose -f docker-compose.prod.yml ps`              |
| Follow a log                | `docker compose -f docker-compose.prod.yml logs -f backend` |
| Restart one service         | `docker compose -f docker-compose.prod.yml restart backend` |
| Stop everything (data kept) | `docker compose -f docker-compose.prod.yml down`            |
| Memory / swap / disk        | `free -h`, `swapon --show`, `df -h /`, `docker system df`   |
| Remove unused images        | `docker image prune -f` (never touches volumes)             |

> **Never run `docker compose -f docker-compose.prod.yml down -v`.** `-v` deletes
> the volumes: the database, the evidence files and the certificates.

### Deploying a new version (with rollback)

1. **WINDOWS POWERSHELL:** step 7 (build + save), then upload:
   `scp -i "$env:USERPROFILE\.ssh\dpdp_key" "$env:USERPROFILE\dpdp-images.tar" "ubuntu@${ip}:~/"`
   (and the source archive from step 10 if Compose/Caddy files changed).
2. **UBUNTU EC2 SERVER:**

   ```bash
   cd ~/dpdp
   # keep the running version for rollback
   docker tag dpdp-backend:prod dpdp-backend:previous
   docker tag dpdp-frontend:prod dpdp-frontend:previous
   # safety copy of the database before migrations (section 16)
   mkdir -p ~/backups && chmod 700 ~/backups
   docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -n public -n app -n pgboss "$POSTGRES_DB"' > ~/backups/pre-release-$(date +%F-%H%M).dump
   docker load -i ~/dpdp-images.tar && rm ~/dpdp-images.tar
   docker compose -f docker-compose.prod.yml run --rm migrate
   docker compose -f docker-compose.prod.yml up -d
   ```

3. **Rollback** (new version misbehaves, no new migrations were needed):

   ```bash
   docker tag dpdp-backend:previous dpdp-backend:prod
   docker tag dpdp-frontend:previous dpdp-frontend:prod
   docker compose -f docker-compose.prod.yml up -d
   ```

   Migrations are forward-only. If the release **did** change the database
   and must be undone, restore the pre-release dump (section 16, option 1)
   together with the previous images.

### Your IP address changed (SSH times out)

**WINDOWS POWERSHELL:** update `ssh_allowed_cidr` in `terraform.tfvars` to the
new `"<ip>/32"` (step 3e), then:

```powershell
terraform -chdir=deploy/single-server/terraform plan -out tfplan   # only the security group may change
terraform -chdir=deploy/single-server/terraform apply tfplan
```

### Replacing your SSH key

Terraform ignores key changes on the server (so a new key never rebuilds it),
and the AWS key pair is only used when a server is first created. To log in
with a new key, add it on the server while the old one still works —
**WINDOWS POWERSHELL**:

```powershell
Get-Content "$env:USERPROFILE\.ssh\<new_key>.pub" | ssh -i "$env:USERPROFILE\.ssh\dpdp_key" ubuntu@$ip "cat >> ~/.ssh/authorized_keys"
```

Test the new key, then remove the old key's line from `~/.ssh/authorized_keys`
on the server. Leave `ssh_public_key_path` unchanged: changing it makes
Terraform replace the AWS key pair, which needs `dpdp-teardown-recovery` (the
old key pair is deleted).

### Changing the server size (B ↔ A)

Set `instance_type` (and optionally a **larger** `root_volume_gb`) in
`terraform.tfvars`, `plan` (must show `aws_instance.server` **updated in-place**,
never replaced), `apply`. AWS stops the server, resizes and starts it (a few
minutes; Docker restarts the containers). After growing the disk, on the
server: `sudo growpart /dev/nvme0n1 1 && sudo resize2fs /dev/nvme0n1p1`.

---

## 16. Backups and recovery

| What                                       | How                                                                                       | Where                                          |
| ------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Whole disk (OS, database, evidence, certs) | Daily snapshot 20:30 UTC = 02:00 IST (07:30 AEDT), last **7** kept, encrypted (automatic) | EBS snapshots, Sydney                          |
| Database (portable)                        | `pg_dump` (below) — before every release and at least weekly                              | server `~/backups`, **copied off-server**      |
| Encryption keys and passwords              | `.env.prod` (step 11)                                                                     | your encrypted storage, never the server alone |
| Terraform state                            | copy after each apply (step 5)                                                            | `%USERPROFILE%\dpdp-backups`                   |

A disk snapshot alone is not a complete recovery plan: it lives in the same
AWS account and region, and is crash-consistent. Keep the database dumps and
`.env.prod` **outside AWS** too. Snapshots are not deleted when the server is.

### Database dump

**UBUNTU EC2 SERVER:**

```bash
mkdir -p ~/backups && chmod 700 ~/backups
cd ~/dpdp
docker compose -f docker-compose.prod.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc -n public -n app -n pgboss "$POSTGRES_DB"' > ~/backups/dpdp-$(date +%F).dump
ls -lh ~/backups
```

**WINDOWS POWERSHELL** — copy off the server:

```powershell
scp -i "$env:USERPROFILE\.ssh\dpdp_key" "ubuntu@${ip}:~/backups/*.dump" "$env:USERPROFILE\dpdp-backups\"
```

A dump contains all customer compliance data (encrypted fields stay
encrypted; the keys are only in `.env.prod`). Store dumps encrypted and
separately from `.env.prod`.

### Restore option 1 — database from a dump (data problem, or a new server)

Requires the **same `.env.prod`** the data was created with: its
`MFA_SECRET_ENC_KEY` and `SUBMISSION_STAGING_ENC_KEY` decrypt the stored
secrets. With different keys the data loads but MFA, consent references and
webhook secrets cannot be decrypted.

**UBUNTU EC2 SERVER** (`.env.prod` restored to `~/dpdp/.env.prod`, mode 600;
images loaded; dump copied to `~/restore.dump`):

```bash
cd ~/dpdp
docker compose -f docker-compose.prod.yml stop backend worker frontend caddy
# Start from an EMPTY database: only on a new server, or after deliberately
# removing the old one with: docker compose -f docker-compose.prod.yml down && docker volume rm dpdp-prod_pgdata
docker compose -f docker-compose.prod.yml up -d postgres
docker compose -f docker-compose.prod.yml run --rm db-bootstrap
docker compose -f docker-compose.prod.yml cp ~/restore.dump postgres:/tmp/restore.dump
docker compose -f docker-compose.prod.yml exec -T postgres sh -c '
  pg_restore -l /tmp/restore.dump | grep -vE " SCHEMA - (public|app) " > /tmp/restore.list &&
  pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --exit-on-error -L /tmp/restore.list /tmp/restore.dump'
docker compose -f docker-compose.prod.yml run --rm migrate      # "No migrations to run!" if the dump is current
docker compose -f docker-compose.prod.yml up -d
```

The schemas `public` and `app` are skipped in the restore list because
`db-bootstrap` already created them; ownership, row-level security, policies
and triggers are restored from the dump.

### Restore option 2 — the whole disk from a snapshot (server broken)

**AWS CONSOLE → EC2 → Instances →** `dpdp-server` **→ Actions → Monitor and
troubleshoot → Replace root volume** → choose a snapshot from **EC2 →
Snapshots** (`dpdp-server-disk`) → Create. The server reboots onto the restored
disk; the IP, DNS and SSH key stay the same. Everything since that snapshot is
lost.

Afterwards, **re-tag the new disk** so the daily snapshots continue:
**EC2 → Volumes** → the new root volume of `dpdp-server` → **Tags** → add
`Backup` = `dpdp-daily`, `Project` = `dpdp`, `Name` = `dpdp-server-disk` and
`ManagedBy` = `terraform` (`Project` is what allows the deployer policy to
resize this disk later). Do this as an administrator in the console, or as
`dpdp-deployer` with `dpdp-teardown-recovery` attached temporarily (section 2).
Then on your PC run `terraform plan`: it may show tag updates on
`aws_instance.server` only — apply them; it must never show a replacement.

### Restore option 3 — the server is gone

Run Terraform again (section 5) for a new server (if Terraform still has the
old one in its state, see "Terraform state" below), then steps 8–13 with the
**backed-up `.env.prod`** instead of generating a new one (copy it to
`~/dpdp/.env.prod`, `chmod 600`), and restore the database with option 1.

---

## 17. Terraform state

Terraform's record of what it created is the local file
`deploy/single-server/terraform/terraform.tfstate` (git-ignored). For this
configuration it contains resource IDs, the IP address and your SSH **public**
key — no passwords. Losing it does not affect the running server, but
Terraform would no longer know the resources: you would re-import them
(`terraform import aws_instance.server <instance-id>`, and likewise for the
others) before making changes. Keep the dated copies from step 5.

A remote state backend (an S3 bucket with versioning) would remove this risk
for well under $0.10/month, but it needs the bucket to exist first (created
outside this Terraform), extra IAM permissions and a one-time
`terraform init -migrate-state`. Not set up; ask if you want it.

---

## 18. Removing everything (deliberate only)

The server and the DNS zone are protected. To remove them on purpose:

1. Take a final `pg_dump` and copy it off the server (section 16), and keep `.env.prod`.
2. **AWS CONSOLE:** attach `dpdp-teardown-recovery` to `dpdp-deployer` (section 2);
   the normal deployer policies cannot delete anything.
3. In `deploy/single-server/terraform/ec2.tf` delete the line
   `prevent_destroy = true` and set `disable_api_termination = false`; in
   `dns.tf` delete `prevent_destroy = true`.
4. **WINDOWS POWERSHELL:**
   `terraform -chdir=deploy/single-server/terraform apply` (turns termination
   protection off), then `terraform -chdir=deploy/single-server/terraform destroy`.
5. The Route 53 zone can only be deleted once the records you added by hand
   (section 6) are removed. A new zone later has **new nameservers** — update
   Namecheap again.
6. Snapshots remain (and cost a little): delete them in **AWS CONSOLE → EC2 →
   Snapshots** when no longer needed. Finally, detach `dpdp-teardown-recovery`.

---

## 19. Security notes

In place: SSH only from your `/32` and only with your key (passwords are off
on Ubuntu cloud images); only ports 80/443 public; PostgreSQL, the API, the
frontend, the Docker daemon and Caddy's admin API are not reachable from the
internet; IMDSv2 required with hop limit 1 (containers cannot reach instance
metadata, and the server has no IAM role anyway); encrypted disk and
snapshots; termination protection; no privileged containers and no Docker
socket mounted into any container; secrets only in `.env.prod` (mode 600,
git-ignored, never in an image); HTTPS with automatic certificates, TLS
1.2/1.3, HSTS.

Known limitations:

- The `ubuntu` user is in the `docker` group, which is equivalent to root on
  the server — protect the SSH key (it has a passphrase only if you set one).
- `.env.prod` is given to every application container (and PostgreSQL), not
  split per service.
- The database connection inside Docker is not TLS-encrypted (it never leaves
  the server).
- No WAF, CSP headers or IP-based rate limiting yet (deliberately deferred).
- Ubuntu installs security updates automatically (unattended-upgrades), but
  Docker Engine and the container images are updated only when you do it.
- One server: no high availability.
- No e-mail/SMS provider yet: portal one-time codes are not delivered until
  Postmark/MSG91 settings are added to `.env.prod` (then `up -d`).

---

## Troubleshooting

| Symptom                                                               | What to do                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `terraform plan`: `No value for required variable ssh_allowed_cidr`   | Set it in `terraform.tfvars` (step 5).                                                                                |
| `terraform plan`: `instance_type is not offered in availability_zone` | Use a zone from step 3(b) for `availability_zone`.                                                                    |
| `terraform plan`: `AccessDenied` / `UnauthorizedOperation`            | `$env:AWS_PROFILE` not set in this window, or the policy is missing an action — note the action named in the error.   |
| `terraform plan`: `Instance cannot be destroyed`                      | The change would replace the server. Do not work around it; undo the change (section 15 lists safe in-place changes). |
| Caddy log: `challenge failed` / `NXDOMAIN`                            | DNS not live yet (step 9). Caddy retries; Let's Encrypt may make it wait about an hour after repeated failures.       |
| Browser: `502 Bad Gateway`                                            | API/frontend not up: `docker compose -f docker-compose.prod.yml ps`, `logs backend`.                                  |
| `backend` keeps restarting                                            | `logs backend` lists every missing/invalid setting by name. Did steps 11 and 12 succeed?                              |
| Browser: "Could not reach the API" / CORS errors                      | The frontend image was built with another `NEXT_PUBLIC_API_URL`. Rebuild (step 7) with `https://api.hhgoa.work`.      |
| `$'\r': command not found`                                            | CRLF line endings: `sed -i 's/\r$//' deploy/single-server/*.sh`.                                                      |
| Server slow, `free -h` shows swap heavily used                        | Memory pressure (configuration B). Check `docker stats --no-stream`; consider configuration A.                        |
