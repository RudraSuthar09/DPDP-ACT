# Values printed after `terraform apply`. Read one with:
#   terraform output -raw <name>

output "route53_nameservers" {
  description = "COPY THESE 4 into Namecheap: Domain List -> Manage -> Nameservers -> Custom DNS."
  value       = local.nameservers
}

output "route53_zone_id" {
  description = "The Route 53 hosted zone in use."
  value       = local.zone_id
}

output "server_ip" {
  description = "The server's fixed public IP address."
  value       = aws_eip.server.public_ip
}

output "server_instance_id" {
  description = "EC2 instance ID (for recovery commands)."
  value       = aws_instance.server.id
}

output "server_availability_zone" {
  description = "Availability Zone of the server and its disk."
  value       = aws_instance.server.availability_zone
}

output "ssh_command" {
  description = "Log in to the server (uses your PRIVATE key from your PC; it never leaves it)."
  value       = "ssh -i \"${local.ssh_private_key_path}\" ubuntu@${aws_eip.server.public_ip}"
}

output "app_url" {
  description = "The web app, once DNS and HTTPS are live."
  value       = "https://${local.app_host}"
}

output "api_url" {
  description = "The API, the frontend's NEXT_PUBLIC_API_URL, and the Gateway's workspace URL."
  value       = "https://${local.api_host}"
}
