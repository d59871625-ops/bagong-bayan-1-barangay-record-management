<?php

if (PHP_SAPI !== "cli") {
    http_response_code(404);
    exit;
}

require_once __DIR__ . "/db.php";

echo "=== CREATE BARANGAY ADMIN ACCOUNT ===\n";

echo "Full name: ";
$fullName = trim(fgets(STDIN));

echo "Email: ";
$email = strtolower(trim(fgets(STDIN)));

echo "Password (minimum 12 characters): ";
$password = trim(fgets(STDIN));

if ($fullName === "" || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
    exit("Invalid name or email.\n");
}

if (strlen($password) < 12) {
    exit("Password must be at least 12 characters.\n");
}

$check = $pdo->prepare("SELECT id FROM users WHERE email = ? LIMIT 1");
$check->execute([$email]);

if ($check->fetch()) {
    exit("This email already has an account.\n");
}

$hash = password_hash($password, PASSWORD_DEFAULT);

$insert = $pdo->prepare("
    INSERT INTO users (full_name, email, password_hash, role, account_status)
    VALUES (?, ?, ?, 'admin', 'active')
");

$insert->execute([$fullName, $email, $hash]);

echo "\nAdmin account created successfully!\n";
echo "Name: " . $fullName . "\n";
echo "Email: " . $email . "\n";
echo "Role: admin\n";
echo "Status: active\n";