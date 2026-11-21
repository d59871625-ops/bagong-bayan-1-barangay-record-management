<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

require_once __DIR__ . "/db.php";

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if (($_SERVER["REQUEST_METHOD"] ?? "") !== "GET") {
    header("Allow: GET, OPTIONS");
    respond(405, ["success" => false, "message" => "Method not allowed."]);
}

$publicKeys = [
    "bb1-community-updates",
    "bb1-about-contact-information",
    "bb1-document-fees",
    "bb1-enabled-certificate-types",
    "bb1-certificate-templates",
    "bb1-gcash-recipients",
    "bb1-official-availability",
    "bb1-official-profiles",
    "bb1-official-photos",
];

try {
    $placeholders = implode(",", array_fill(0, count($publicKeys), "?"));
    $statement = $pdo->prepare(
        "SELECT data_key, data_value FROM bb1_app_state WHERE data_key IN ($placeholders) ORDER BY data_key"
    );
    $statement->execute($publicKeys);

    $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
    $etagContext = hash_init("sha256");
    foreach ($rows as $row) {
        hash_update($etagContext, $row["data_key"] . "\0" . $row["data_value"] . "\0");
    }
    $etag = '"' . hash_final($etagContext) . '"';
    header("X-Public-Data-ETag: " . $etag);

    $clientEtag = trim($_SERVER["HTTP_X_PUBLIC_DATA_MATCH"] ?? "");
    if ($clientEtag !== "" && hash_equals($etag, $clientEtag)) {
        http_response_code(304);
        exit;
    }

    $data = [];
    foreach ($rows as $row) {
        $data[$row["data_key"]] = json_decode($row["data_value"], false, 512, JSON_THROW_ON_ERROR);
    }

    respond(200, ["success" => true, "data" => (object) $data]);
} catch (Throwable $error) {
    error_log("Public community data error: " . $error->getMessage());
    respond(500, ["success" => false, "message" => "Unable to load public community information."]);
}
