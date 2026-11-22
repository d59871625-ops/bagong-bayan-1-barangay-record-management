ALTER TABLE registration_requests
    MODIFY COLUMN email VARCHAR(190) NULL;

CREATE TABLE IF NOT EXISTS registration_application_details (
    registration_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    submission_key VARCHAR(64) NOT NULL UNIQUE,
    application_data LONGTEXT NOT NULL,
    valid_id LONGTEXT NOT NULL,
    proof_of_residence LONGTEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
