<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store");

require_once __DIR__ . "/vendor/autoload.php";
require_once __DIR__ . "/db.php";

use PHPMailer\PHPMailer\PHPMailer;

function respondPasswordReset(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function ensurePasswordResetTable(PDO $pdo): void
{
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS admin_password_reset_codes (
            id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            user_id BIGINT UNSIGNED NOT NULL,
            code_hash CHAR(64) NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP NOT NULL,
            used_at TIMESTAMP NULL DEFAULT NULL,
            INDEX idx_password_reset_user_created (user_id, created_at),
            CONSTRAINT fk_password_reset_user
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
}

function sendPasswordResetEmail(string $recipient, string $code): void
{
    $username = trim((string) getenv("BRGY_GMAIL_USERNAME"));
    $appPassword = preg_replace('/\s+/', '', (string) getenv("BRGY_GMAIL_APP_PASSWORD"));
    $senderName = trim((string) getenv("BRGY_GMAIL_FROM_NAME")) ?: "Barangay Bagong Bayan I";
    if ($username === "" || $appPassword === "") {
        throw new RuntimeException("Email delivery is not configured on the backend.");
    }

    $mail = new PHPMailer(true);
    $mail->isSMTP();
    $mail->Host = "smtp.gmail.com";
    $mail->SMTPAuth = true;
    $mail->Username = $username;
    $mail->Password = $appPassword;
    $mail->SMTPSecure = PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port = 587;
    $mail->CharSet = "UTF-8";
    $mail->setFrom($username, $senderName);
    $mail->addAddress($recipient);
    $mail->Subject = "Barangay admin password reset code";
    $mail->isHTML(true);
    $mail->Body = "<p>Your Barangay Bagong Bayan I admin password reset code is:</p>"
        . "<p style=\"font-size:24px;font-weight:bold;letter-spacing:4px\">" . htmlspecialchars($code, ENT_QUOTES | ENT_SUBSTITUTE, "UTF-8") . "</p>"
        . "<p>This code expires in 15 minutes. If you did not request it, ignore this email.</p>";
    $mail->AltBody = "Your Barangay Bagong Bayan I admin password reset code is {$code}. "
        . "It expires in 15 minutes. If you did not request it, ignore this email.";
    $mail->send();
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "POST") {
    header("Allow: POST, OPTIONS");
    respondPasswordReset(405, ["success" => false, "message" => "Method not allowed."]);
}

$input = json_decode(file_get_contents("php://input"), true);
if (!is_array($input)) {
    respondPasswordReset(400, ["success" => false, "message" => "Invalid request."]);
}

$action = strtolower(trim((string) ($input["action"] ?? "")));
$email = strtolower(trim((string) ($input["email"] ?? "")));
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    respondPasswordReset(422, ["success" => false, "message" => "Enter a valid Gmail address."]);
}

try {
    ensurePasswordResetTable($pdo);

    if ($action === "request") {
        $stmt = $pdo->prepare("
            SELECT id
            FROM users
            WHERE email = ?
              AND role IN ('admin', 'official')
              AND account_status = 'active'
            LIMIT 1
        ");
        $stmt->execute([$email]);
        $user = $stmt->fetch(PDO::FETCH_ASSOC);

        if ($user) {
            $code = str_pad((string) random_int(0, 999999), 6, "0", STR_PAD_LEFT);
            $codeHash = hash("sha256", $code);
            $pdo->beginTransaction();
            $invalidate = $pdo->prepare("
                UPDATE admin_password_reset_codes
                SET used_at = NOW()
                WHERE user_id = ? AND used_at IS NULL
            ");
            $invalidate->execute([(int) $user["id"]]);
            $insert = $pdo->prepare("
                INSERT INTO admin_password_reset_codes (user_id, code_hash, expires_at)
                VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))
            ");
            $insert->execute([(int) $user["id"], $codeHash]);
            $pdo->commit();

            try {
                sendPasswordResetEmail($email, $code);
            } catch (Throwable $emailError) {
                error_log("Admin password reset email failed: " . $emailError->getMessage());
                respondPasswordReset(502, [
                    "success" => false,
                    "message" => "The reset email could not be sent. Check Gmail SMTP configuration and try again.",
                ]);
            }
        }

        respondPasswordReset(200, [
            "success" => true,
            "message" => "If the Gmail address belongs to an active admin account, a reset code has been sent.",
        ]);
    }

    if ($action === "reset") {
        $code = trim((string) ($input["code"] ?? ""));
        $password = (string) ($input["password"] ?? "");
        if (!preg_match('/^[0-9]{6}$/', $code)) {
            respondPasswordReset(422, ["success" => false, "message" => "Enter the 6-digit reset code."]);
        }
        if (strlen($password) < 12) {
            respondPasswordReset(422, ["success" => false, "message" => "Use a new password with at least 12 characters."]);
        }

        $pdo->beginTransaction();
        $stmt = $pdo->prepare("
            SELECT r.id, r.user_id, r.code_hash, u.account_status
            FROM admin_password_reset_codes r
            INNER JOIN users u ON u.id = r.user_id
            WHERE u.email = ?
              AND u.role IN ('admin', 'official')
              AND r.used_at IS NULL
              AND r.expires_at > NOW()
            ORDER BY r.created_at DESC, r.id DESC
            LIMIT 1
            FOR UPDATE
        ");
        $stmt->execute([$email]);
        $reset = $stmt->fetch(PDO::FETCH_ASSOC);

        if (!$reset
            || $reset["account_status"] !== "active"
            || !hash_equals((string) $reset["code_hash"], hash("sha256", $code))) {
            $pdo->rollBack();
            respondPasswordReset(401, ["success" => false, "message" => "The reset code is invalid or expired."]);
        }

        $passwordHash = password_hash($password, PASSWORD_DEFAULT);
        if ($passwordHash === false) {
            throw new RuntimeException("Unable to hash the new password.");
        }

        $updatePassword = $pdo->prepare("UPDATE users SET password_hash = ? WHERE id = ? AND account_status = 'active'");
        $updatePassword->execute([$passwordHash, (int) $reset["user_id"]]);
        $revoke = $pdo->prepare("UPDATE api_tokens SET revoked_at = NOW() WHERE user_id = ? AND revoked_at IS NULL");
        $revoke->execute([(int) $reset["user_id"]]);
        $markUsed = $pdo->prepare("UPDATE admin_password_reset_codes SET used_at = NOW() WHERE id = ?");
        $markUsed->execute([(int) $reset["id"]]);
        $pdo->commit();

        respondPasswordReset(200, [
            "success" => true,
            "message" => "Password changed successfully.",
        ]);
    }

    respondPasswordReset(422, ["success" => false, "message" => "Unsupported password reset action."]);
} catch (Throwable $error) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log("Admin password reset error: " . $error->getMessage());
    respondPasswordReset(500, ["success" => false, "message" => "Unable to process the password reset."]);
}
