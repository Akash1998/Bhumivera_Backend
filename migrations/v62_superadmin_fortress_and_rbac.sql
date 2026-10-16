-- =============================================================================
-- BHUMIVERA MAISON — PRODUCTION DATABASE MIGRATION (V62)
-- Target: Railway MySQL 8.0+ (InnoDB / utf8mb4_unicode_ci)
-- Scope:
--   1. SuperAdmin Security Vault & Multi-Factor Challenge State
--   2. Granular RBAC Staff Accounts & 110-Module Per-User Permission Matrix
--   3. Atomic Wallet & Gateway Refund Restoration Ledger
--   4. Verified Customer Support Escalation Tickets (3-Step Anti-Spam Flow)
--   5. Real-Time API Route Telemetry & Chained Cryptographic Audit Logs
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;

-- 1. SUPERADMIN SECURITY VAULT (`adminbhumivera27@gmail.com` Exclusive)
CREATE TABLE IF NOT EXISTS `superadmin_security_vault` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `authorized_email` VARCHAR(150) NOT NULL UNIQUE DEFAULT 'adminbhumivera27@gmail.com',
  `is_onboarded` TINYINT(1) NOT NULL DEFAULT 0,
  `primary_password_hash` VARCHAR(512) NULL,
  `secondary_vault_password_hash` VARCHAR(512) NULL,
  `action_passcode_hash` VARCHAR(512) NULL,
  `security_questions_encrypted` TEXT NULL,
  `last_rotated_question_index` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `failed_login_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME NULL,
  `last_login_at` DATETIME NULL,
  `last_login_ip` VARCHAR(64) NULL,
  `vault_signature_sha512` CHAR(128) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_sa_vault_email` (`authorized_email`, `is_onboarded`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ensure initial un-onboarded vault record exists for `adminbhumivera27@gmail.com`
INSERT IGNORE INTO `superadmin_security_vault` (`authorized_email`, `is_onboarded`)
VALUES ('adminbhumivera27@gmail.com', 0);

-- 2. TIME-BOUND SUPERADMIN OTP CHALLENGES (5-Minute Expiry, Max 3 Attempts)
CREATE TABLE IF NOT EXISTS `superadmin_otp_challenges` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `challenge_id` VARCHAR(64) NOT NULL UNIQUE,
  `authorized_email` VARCHAR(150) NOT NULL,
  `purpose` ENUM('onboarding', 'multi_factor_login', 'step_up_action') NOT NULL DEFAULT 'multi_factor_login',
  `otp_hash` VARCHAR(256) NOT NULL,
  `selected_question_index` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `max_attempts` INT UNSIGNED NOT NULL DEFAULT 3,
  `expires_at` DATETIME NOT NULL,
  `consumed_at` DATETIME NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sa_otp_email_expires` (`authorized_email`, `purpose`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. UNIFIED STAFF ACCOUNTS REGISTRY (Supports 10+ Staff Logins Across All Portals)
CREATE TABLE IF NOT EXISTS `staff_accounts` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(80) NOT NULL UNIQUE,
  `email` VARCHAR(150) NOT NULL UNIQUE,
  `full_name` VARCHAR(120) NOT NULL,
  `password_hash` VARCHAR(512) NOT NULL,
  `primary_portal` ENUM('admin', 'warehouse', 'support', 'superadminsupport', 'controlcentre') NOT NULL DEFAULT 'admin',
  `role_title` VARCHAR(80) NOT NULL DEFAULT 'Executive Administrator',
  `department` VARCHAR(80) NOT NULL DEFAULT 'Maison Operations',
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `failed_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME NULL,
  `last_login_at` DATETIME NULL,
  `created_by_email` VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_staff_portal_active` (`primary_portal`, `is_active`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. DYNAMIC PER-USER MODULE PERMISSION MATRIX (100+ Modules: Hidden / Read-Only / Write / Full)
CREATE TABLE IF NOT EXISTS `staff_module_permissions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `staff_id` INT UNSIGNED NOT NULL,
  `module_key` VARCHAR(100) NOT NULL,
  `access_level` ENUM('hidden', 'read', 'write', 'full') NOT NULL DEFAULT 'read',
  `updated_by` VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
  `signature_sha512` CHAR(128) NOT NULL,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uq_staff_module` (`staff_id`, `module_key`),
  INDEX `idx_staff_module_lookup` (`module_key`, `access_level`),
  CONSTRAINT `fk_staff_perm_account` FOREIGN KEY (`staff_id`) REFERENCES `staff_accounts` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. ATOMIC WALLET & GATEWAY REFUND RESTORATION LEDGER
CREATE TABLE IF NOT EXISTS `wallet_refund_ledger` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ledger_reference` VARCHAR(64) NOT NULL UNIQUE,
  `order_id` INT NOT NULL,
  `order_number` VARCHAR(32) NOT NULL,
  `return_id` INT NULL,
  `user_id` INT NOT NULL,
  `source_payment_mode` ENUM('WALLET', 'online', 'COD') NOT NULL,
  `refund_destination` ENUM('WALLET_INSTANT', 'ORIGINAL_GATEWAY', 'INTERNAL_REFUND_LEDGER') NOT NULL,
  `wallet_credited_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `referral_credited_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `gateway_refund_amount` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `wallet_balance_before` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `wallet_balance_after` DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  `gateway_payment_id` VARCHAR(120) NULL,
  `gateway_refund_id` VARCHAR(120) NULL,
  `gateway_status` ENUM('NOT_APPLICABLE', 'INITIATED', 'PENDING_WEBHOOK', 'PROCESSED', 'CREDITED_TO_WALLET_FALLBACK') NOT NULL DEFAULT 'NOT_APPLICABLE',
  `reason` TEXT NOT NULL,
  `executed_by_email` VARCHAR(150) NOT NULL DEFAULT 'adminbhumivera27@gmail.com',
  `signature_sha512` CHAR(128) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_wallet_refund_order` (`order_id`, `created_at`),
  INDEX `idx_wallet_refund_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_wallet_refund_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_wallet_refund_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. VERIFIED CUSTOMER SUPPORT ESCALATION TICKETS (3-Step Anti-Spam Concierge Flow)
CREATE TABLE IF NOT EXISTS `support_escalation_tickets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `ticket_reference` VARCHAR(32) NOT NULL UNIQUE,
  `session_id` BIGINT UNSIGNED NULL,
  `user_id` INT NOT NULL,
  `order_id` INT NOT NULL,
  `order_number` VARCHAR(32) NOT NULL,
  `verified_email` VARCHAR(150) NULL,
  `verified_phone` VARCHAR(20) NULL,
  `contact_preference` ENUM('email', 'phone_call') NOT NULL,
  `callback_phone` VARCHAR(20) NULL,
  `callback_time_slot` VARCHAR(80) NULL,
  `inquiry_category` VARCHAR(80) NOT NULL DEFAULT 'Order Intervention',
  `query_details` TEXT NOT NULL,
  `status` ENUM('open', 'assigned', 'in_progress', 'resolved', 'closed') NOT NULL DEFAULT 'open',
  `sla_deadline` DATETIME NOT NULL,
  `assigned_staff_id` INT UNSIGNED NULL,
  `resolution_notes` TEXT NULL,
  `signature_sha512` CHAR(128) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_esc_ticket_order` (`order_id`, `status`),
  INDEX `idx_esc_ticket_user` (`user_id`, `created_at`),
  CONSTRAINT `fk_esc_ticket_order` FOREIGN KEY (`order_id`) REFERENCES `orders` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_esc_ticket_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. REAL-TIME API ENDPOINT TELEMETRY & LATENCY LOGS
CREATE TABLE IF NOT EXISTS `api_telemetry_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `route_pattern` VARCHAR(160) NOT NULL,
  `http_method` VARCHAR(12) NOT NULL,
  `status_code` SMALLINT UNSIGNED NOT NULL,
  `latency_ms` INT UNSIGNED NOT NULL,
  `request_id` VARCHAR(64) NULL,
  `error_code` VARCHAR(100) NULL,
  `actor_role` VARCHAR(40) NULL,
  `recorded_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_api_telemetry_route_time` (`route_pattern`, `recorded_at`),
  INDEX `idx_api_telemetry_status_time` (`status_code`, `recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. SUPERADMIN CRYPTOGRAPHIC AUDIT TRAIL (Chained SHA-512 Digest)
CREATE TABLE IF NOT EXISTS `superadmin_vault_audit_logs` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `actor_email` VARCHAR(150) NOT NULL,
  `action_code` VARCHAR(80) NOT NULL,
  `target_entity` VARCHAR(120) NULL,
  `payload_summary` TEXT NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  `prev_hash_sha512` CHAR(128) NOT NULL,
  `signature_sha512` CHAR(128) NOT NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_sa_audit_created` (`created_at`, `action_code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
