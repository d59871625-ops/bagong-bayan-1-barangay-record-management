CREATE TABLE IF NOT EXISTS admin_invitations (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    invited_email VARCHAR(254) NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    inviter_user_id BIGINT UNSIGNED NOT NULL,
    status ENUM('pending', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    responded_at TIMESTAMP NULL DEFAULT NULL,
    INDEX idx_admin_invitation_email_status (invited_email, status),
    INDEX idx_admin_invitation_inviter_created (inviter_user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
