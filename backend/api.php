<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";
require_once __DIR__ . "/resident-request-storage.php";

// Admin and officials only.
$user = authenticateUser($pdo, ["admin", "official"]);

function respond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function bb1RequestHasEvidence($request): bool
{
    if (!($request instanceof stdClass)) {
        return false;
    }

    $photos = $request->requirementPhotos ?? null;
    if ($photos instanceof stdClass) {
        foreach (get_object_vars($photos) as $photo) {
            if ($photo instanceof stdClass
                && is_string($photo->dataUrl ?? null)
                && strpos($photo->dataUrl, "data:image/") === 0) {
                return true;
            }
        }
    }

    $evidence = $request->philsysVerificationEvidence ?? null;
    if (is_string($evidence) && strpos($evidence, "data:image/") === 0) {
        return true;
    }
    if ($evidence instanceof stdClass
        && is_string($evidence->dataUrl ?? null)
        && strpos($evidence->dataUrl, "data:image/") === 0) {
        return true;
    }

    return false;
}

function bb1StripRequestEvidence($request)
{
    if (!($request instanceof stdClass)) {
        return $request;
    }

    unset(
        $request->requirementPhotos,
        $request->philsysVerificationEvidence
    );

    return $request;
}

$allowedKeys = [
    "bb1-community-updates",
    "bb1-about-contact-information",
    "bb1-resident-requests",
    "bb1-deleted-request-ids",
    "bb1-resident-payment-drafts",
    "bb1-resident-request-drafts",
    "bb1-gcash-recipients",
    "bb1-resident-records",
    "bb1-registration-requests",
    "bb1-resident-code-recovery-requests",
    "bb1-resident-profile-update-requests",
    "bb1-document-fees",
    "bb1-document-fees-defaults-version",
    "bb1-admin-preferences",
    "bb1-resident-history",
    "bb1-archived-residents",
    "bb1-issued-documents",
    "bb1-certificate-templates",
    "bb1-official-availability",
    "bb1-enabled-certificate-types",
    "bb1-official-profiles",
    "bb1-official-photos"
];

try {
    if ($_SERVER["REQUEST_METHOD"] === "GET" && ($_GET["health"] ?? "") === "1") {
        $pdo->query("SELECT 1")->fetchColumn();
        respond(200, ["success" => true, "database" => "connected"]);
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    bb1EnsureResidentRequestChangesTable($pdo);

    if ($_SERVER["REQUEST_METHOD"] === "GET") {
        if (array_key_exists("requestEvidence", $_GET)) {
            $requestId = trim((string) $_GET["requestEvidence"]);
            if (!preg_match('/^[A-Za-z0-9._:-]{1,100}$/', $requestId)) {
                respond(400, ["success" => false, "message" => "A valid resident request ID is required."]);
            }

            $changeStatement = $pdo->prepare("
                SELECT data_value, is_deleted
                FROM bb1_resident_request_changes
                WHERE request_id = ?
                LIMIT 1
            ");
            $changeStatement->execute([$requestId]);
            $change = $changeStatement->fetch();
            $request = null;
            if ($change) {
                if ((int) $change["is_deleted"] === 0 && $change["data_value"] !== null) {
                    $request = json_decode($change["data_value"], false, 512, JSON_THROW_ON_ERROR);
                }
            } else {
                $requestStatement = $pdo->prepare("
                    SELECT data_value
                    FROM bb1_app_state
                    WHERE data_key = ?
                    LIMIT 1
                ");
                $requestStatement->execute(["bb1-resident-requests"]);
                $requestJson = $requestStatement->fetchColumn();
                if ($requestJson !== false) {
                    $savedRequests = json_decode($requestJson, false, 512, JSON_THROW_ON_ERROR);
                    if (is_array($savedRequests)) {
                        foreach ($savedRequests as $savedRequest) {
                            if ($savedRequest instanceof stdClass
                                && (string) ($savedRequest->id ?? "") === $requestId) {
                                $request = $savedRequest;
                                break;
                            }
                        }
                    }
                }
            }

            if (!($request instanceof stdClass)) {
                respond(404, ["success" => false, "message" => "The resident request or its evidence could not be found."]);
            }
            respond(200, ["success" => true, "data" => ["request" => $request]]);
        }

        if (($_GET["counts"] ?? "") === "1") {
            $residentCountStatement = $pdo->prepare("
                SELECT JSON_TYPE(data_value), JSON_LENGTH(data_value)
                FROM bb1_app_state
                WHERE data_key = ?
                LIMIT 1
            ");
            $residentCountStatement->execute(["bb1-resident-records"]);
            $residentCountRow = $residentCountStatement->fetch(PDO::FETCH_NUM);
            if ($residentCountRow && ($residentCountRow[0] !== "ARRAY" || !is_numeric($residentCountRow[1]))) {
                throw new RuntimeException("Saved resident records are not a list.");
            }
            $residentCount = $residentCountRow ? (int) $residentCountRow[1] : 0;

            $requestIdsStatement = $pdo->prepare("
                SELECT JSON_EXTRACT(data_value, '$[*].id')
                FROM bb1_app_state
                WHERE data_key = ?
                LIMIT 1
            ");
            $requestIdsStatement->execute(["bb1-resident-requests"]);
            $requestIdsJson = $requestIdsStatement->fetchColumn();
            $baseRequestIds = $requestIdsJson === false || $requestIdsJson === null
                ? []
                : json_decode((string) $requestIdsJson, true, 512, JSON_THROW_ON_ERROR);
            if ($baseRequestIds === null) {
                $baseRequestIds = [];
            }
            if (!is_array($baseRequestIds)) {
                throw new RuntimeException("Saved resident requests are not a list.");
            }

            $requestIds = [];
            foreach ($baseRequestIds as $requestId) {
                if (!is_scalar($requestId) || (string) $requestId === "") {
                    throw new RuntimeException("A saved resident request is invalid.");
                }
                $requestIds[(string) $requestId] = true;
            }

            $historyStatement = $pdo->prepare("
                SELECT data_value
                FROM bb1_app_state
                WHERE data_key = ?
                LIMIT 1
            ");
            $historyStatement->execute(["bb1-resident-history"]);
            $historyJson = $historyStatement->fetchColumn();
            $history = $historyJson === false
                ? []
                : json_decode((string) $historyJson, false, 512, JSON_THROW_ON_ERROR);
            if (!is_array($history)) {
                throw new RuntimeException("Saved resident history is not a list.");
            }
            $historyRequestIds = [];
            foreach ($history as $entry) {
                if (($entry->type ?? null) === "documentRequest"
                    && ($entry->request ?? null) instanceof stdClass
                    && is_scalar($entry->request->id ?? null)
                    && (string) $entry->request->id !== "") {
                    $historyRequestIds[(string) $entry->request->id] = true;
                }
            }

            $changeStatement = $pdo->query("
                SELECT request_id, is_deleted,
                    JSON_UNQUOTE(JSON_EXTRACT(data_value, '$.id')) AS data_id
                FROM bb1_resident_request_changes
                ORDER BY request_id
            ");
            foreach ($changeStatement->fetchAll(PDO::FETCH_ASSOC) as $change) {
                $requestId = (string) ($change["request_id"] ?? "");
                if ($requestId === "") {
                    throw new RuntimeException("A saved resident request change is invalid.");
                }
                if ((int) ($change["is_deleted"] ?? 0) === 1) {
                    unset($requestIds[$requestId]);
                    continue;
                }
                if ((string) ($change["data_id"] ?? "") !== $requestId) {
                    throw new RuntimeException("A saved resident request change is invalid.");
                }
                $requestIds[$requestId] = true;
            }

            $deletedIdsStatement = $pdo->prepare("
                SELECT data_value
                FROM bb1_app_state
                WHERE data_key = ?
                LIMIT 1
            ");
            $deletedIdsStatement->execute(["bb1-deleted-request-ids"]);
            $deletedIdsJson = $deletedIdsStatement->fetchColumn();
            $deletedIds = $deletedIdsJson === false
                ? []
                : json_decode((string) $deletedIdsJson, true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($deletedIds)) {
                throw new RuntimeException("Saved deleted request IDs are not a list.");
            }
            foreach ($deletedIds as $requestId) {
                if (!is_string($requestId)) {
                    throw new RuntimeException("A saved deleted request ID is invalid.");
                }
                unset($requestIds[$requestId], $historyRequestIds[$requestId]);
            }

            respond(200, [
                "success" => true,
                "counts" => [
                    "residents" => $residentCount,
                    "requests" => count($requestIds + $historyRequestIds),
                ],
            ]);
        }

        $isPriorityLoad = ($_GET["priority"] ?? "") === "1";
        $requestChanges = bb1LoadResidentRequestChanges($pdo, $isPriorityLoad);
        $priorityRequestSummary = $isPriorityLoad
            ? bb1LoadPriorityResidentRequests($pdo)
            : ["requests" => [], "evidence_ids" => []];
        $priorityKeys = array_values(array_diff($allowedKeys, [
            "bb1-registration-requests",
            "bb1-resident-payment-drafts",
            "bb1-resident-request-drafts",
            "bb1-resident-history",
            "bb1-archived-residents",
            "bb1-issued-documents",
            "bb1-certificate-templates",
            "bb1-official-photos",
        ]));
        $responseKeys = $isPriorityLoad
            ? array_values(array_diff($priorityKeys, ["bb1-resident-requests"]))
            : $allowedKeys;
        $placeholders = implode(",", array_fill(0, count($responseKeys), "?"));
        $statement = $pdo->prepare(
            "SELECT data_key, data_value FROM bb1_app_state WHERE data_key IN ($placeholders) ORDER BY data_key"
        );
        $statement->execute($responseKeys);

        $rows = $statement->fetchAll();
        if (!$isPriorityLoad) {
            $etagContext = hash_init("sha256");
            foreach ($rows as $row) {
                hash_update($etagContext, $row["data_key"] . "\0" . $row["data_value"] . "\0");
            }
            foreach ($requestChanges as $change) {
                hash_update(
                    $etagContext,
                    "resident-request-change\0"
                        . $change["request_id"] . "\0"
                        . (string) $change["is_deleted"] . "\0"
                        . (string) ($change["data_value"] ?? "") . "\0"
                );
            }
            $etag = '"' . hash_final($etagContext) . '"';
            header("ETag: " . $etag);
            $clientEtag = trim($_SERVER["HTTP_IF_NONE_MATCH"] ?? "");
            if ($clientEtag !== "" && hash_equals($etag, $clientEtag)) {
                http_response_code(304);
                exit;
            }
        }

        $data = [];
        foreach ($rows as $row) {
            $data[$row["data_key"]] = json_decode($row["data_value"], false, 512, JSON_THROW_ON_ERROR);
        }
        if ($isPriorityLoad) {
            $data["bb1-resident-requests"] = $priorityRequestSummary["requests"];
        }
        $baseRequests = $data["bb1-resident-requests"] ?? [];
        $requests = bb1MergeResidentRequestChanges($baseRequests, $requestChanges);
        $requestEvidenceIdSet = array_fill_keys($priorityRequestSummary["evidence_ids"], true);
        foreach ($requests as $request) {
            if ($request instanceof stdClass
                && is_scalar($request->id ?? null)
                && (string) $request->id !== ""
                && bb1RequestHasEvidence($request)) {
                $requestEvidenceIdSet[(string) $request->id] = true;
            }
        }
        foreach ($requestChanges as $change) {
            $requestId = (string) ($change["request_id"] ?? "");
            if ((int) ($change["is_deleted"] ?? 0) === 1) {
                unset($requestEvidenceIdSet[$requestId]);
            } elseif ($isPriorityLoad) {
                if ((int) ($change["has_evidence"] ?? 0) === 1) {
                    $requestEvidenceIdSet[$requestId] = true;
                } else {
                    unset($requestEvidenceIdSet[$requestId]);
                }
            }
        }
        $data["requestEvidenceIds"] = array_keys($requestEvidenceIdSet);
        $data["bb1-resident-requests"] = array_map("bb1StripRequestEvidence", $requests);

        respond(200, ["success" => true, "data" => (object) $data]);
    }

    if ($_SERVER["REQUEST_METHOD"] !== "POST") {
        header("Allow: GET, POST, OPTIONS");
        respond(405, ["success" => false, "message" => "Method not allowed."]);
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state_snapshots (
            snapshot_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
            data_key VARCHAR(100) NOT NULL,
            data_value LONGTEXT NOT NULL,
            created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_snapshot_key_created (data_key, created_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");

    $input = json_decode(file_get_contents("php://input"), false, 512, JSON_THROW_ON_ERROR);
    if (!($input instanceof stdClass)) {
        respond(400, ["success" => false, "message" => "A records object or key and value are required."]);
    }

    $records = property_exists($input, "records")
        ? $input->records
        : (isset($input->key) && property_exists($input, "value")
            ? (object) [$input->key => $input->value]
            : new stdClass());
    if (!($records instanceof stdClass)) {
        respond(400, ["success" => false, "message" => "Database records must be an object."]);
    }

    $requestUpserts = property_exists($input, "requestUpserts") ? $input->requestUpserts : [];
    $requestDeletes = property_exists($input, "requestDeletes") ? $input->requestDeletes : [];
    if (!is_array($requestUpserts)
        || ($requestUpserts && array_keys($requestUpserts) !== range(0, count($requestUpserts) - 1))
        || count($requestUpserts) > 500
        || !is_array($requestDeletes)
        || ($requestDeletes && array_keys($requestDeletes) !== range(0, count($requestDeletes) - 1))
        || count($requestDeletes) > 1000) {
        respond(400, ["success" => false, "message" => "Resident request changes must be valid lists."]);
    }
    $requestUpsertIds = [];
    foreach ($requestUpserts as $request) {
        if (!($request instanceof stdClass)
            || !isset($request->id)
            || (!is_string($request->id) && !is_int($request->id))) {
            respond(400, ["success" => false, "message" => "A resident request change is invalid."]);
        }
        $requestId = (string) $request->id;
        if (trim($requestId) === "" || strlen($requestId) > 100
            || isset($requestUpsertIds[$requestId])) {
            respond(400, ["success" => false, "message" => "A resident request change is invalid."]);
        }
        $requestUpsertIds[$requestId] = true;
    }
    $requestDeleteIds = [];
    foreach ($requestDeletes as $requestId) {
        if (!is_string($requestId)
            || trim($requestId) === ""
            || strlen($requestId) > 100
            || isset($requestDeleteIds[$requestId])
            || isset($requestUpsertIds[$requestId])) {
            respond(400, ["success" => false, "message" => "A resident request deletion is invalid."]);
        }
        $requestDeleteIds[$requestId] = true;
    }
    $hasRequestChanges = count($requestUpserts) > 0 || count($requestDeletes) > 0;
    if (!get_object_vars($records) && !$hasRequestChanges) {
        respond(400, ["success" => false, "message" => "A non-empty records object is required."]);
    }

    $encodedRecords = [];
    foreach ($records as $key => $recordValue) {
        if (!is_string($key) || !in_array($key, $allowedKeys, true)) {
            respond(400, ["success" => false, "message" => "This record is not enabled for database storage."]);
        }
        if ($key === "bb1-resident-records") {
            if (!is_array($recordValue) || ($recordValue && array_keys($recordValue) !== range(0, count($recordValue) - 1))) {
                respond(400, ["success" => false, "message" => "Resident records must be a list."]);
            }
            foreach ($recordValue as $resident) {
                if (!($resident instanceof stdClass)) {
                    respond(400, ["success" => false, "message" => "Each resident record must be an object."]);
                }
            }
        }
        if ($key === "bb1-resident-requests") {
            if (!is_array($recordValue) || ($recordValue && array_keys($recordValue) !== range(0, count($recordValue) - 1))) {
                respond(400, ["success" => false, "message" => "Resident requests must be a list."]);
            }
            $requestIds = [];
            foreach ($recordValue as $request) {
                if (!($request instanceof stdClass)
                    || !isset($request->id)
                    || (!is_string($request->id) && !is_int($request->id))
                    || trim((string) $request->id) === "") {
                    respond(400, ["success" => false, "message" => "Each resident request must have an ID."]);
                }
                $requestId = (string) $request->id;
                if (isset($requestIds[$requestId])) {
                    respond(400, ["success" => false, "message" => "Resident request IDs must be unique."]);
                }
                $requestIds[$requestId] = true;
            }
        }
        $encodedRecords[$key] = json_encode(
            $recordValue,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
    }

    $statement = $pdo->prepare("
        INSERT INTO bb1_app_state (data_key, data_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE data_value = VALUES(data_value)
    ");
    $pdo->beginTransaction();
    try {
        $snapshotInsert = $pdo->prepare("
            INSERT INTO bb1_app_state_snapshots (data_key, data_value)
            VALUES (?, ?)
        ");
        $snapshotSelect = $pdo->prepare("
            SELECT data_key, data_value
            FROM bb1_app_state
            WHERE data_key = ?
            LIMIT 1
        ");
        $snapshotKeys = array_keys($encodedRecords);
        if ($hasRequestChanges && !in_array("bb1-resident-requests", $snapshotKeys, true)) {
            $snapshotKeys[] = "bb1-resident-requests";
        }
        foreach (array_unique($snapshotKeys) as $snapshotKey) {
            $snapshotSelect->execute([$snapshotKey]);
            $snapshotValue = $snapshotSelect->fetchColumn();
            if ($snapshotValue !== false) {
                $snapshotInsert->execute([$snapshotKey, $snapshotValue]);
            }
        }
        if ($hasRequestChanges || array_key_exists("bb1-resident-requests", $encodedRecords)) {
            $ensureRequestState = $pdo->prepare("
                INSERT IGNORE INTO bb1_app_state (data_key, data_value)
                VALUES (?, '[]')
            ");
            $ensureRequestState->execute(["bb1-resident-requests"]);
            $lockRequestState = $pdo->prepare("
                SELECT data_key
                FROM bb1_app_state
                WHERE data_key = ?
                LIMIT 1
                FOR UPDATE
            ");
            $lockRequestState->execute(["bb1-resident-requests"]);
        }
        foreach ($encodedRecords as $key => $value) {
            if ($key === "bb1-resident-requests") {
                $ensureRequestState = $pdo->prepare("
                    INSERT IGNORE INTO bb1_app_state (data_key, data_value)
                    VALUES (?, '[]')
                ");
                $ensureRequestState->execute([$key]);
                $existingRequestStatement = $pdo->prepare("
                    SELECT data_value
                    FROM bb1_app_state
                    WHERE data_key = ?
                    LIMIT 1
                    FOR UPDATE
                ");
                $existingRequestStatement->execute([$key]);
                $existingRequestJson = $existingRequestStatement->fetchColumn();
                $existingRequests = json_decode($existingRequestJson, false, 512, JSON_THROW_ON_ERROR);
                if (!is_array($existingRequests)) {
                    throw new RuntimeException("Saved resident requests are not a list.");
                }
                $existingRequests = bb1MergeResidentRequestChanges(
                    $existingRequests,
                    bb1LoadResidentRequestChanges($pdo)
                );

                $loadStateForMerge = static function (string $stateKey, $fallback) use ($pdo, $records) {
                    if (property_exists($records, $stateKey)) {
                        return $records->{$stateKey};
                    }
                    $stateStatement = $pdo->prepare("
                        SELECT data_value
                        FROM bb1_app_state
                        WHERE data_key = ?
                        LIMIT 1
                        FOR UPDATE
                    ");
                    $stateStatement->execute([$stateKey]);
                    $stateJson = $stateStatement->fetchColumn();
                    return $stateJson === false
                        ? $fallback
                        : json_decode($stateJson, false, 512, JSON_THROW_ON_ERROR);
                };
                $deletedRequestIds = $loadStateForMerge("bb1-deleted-request-ids", []);
                $residentHistory = $loadStateForMerge("bb1-resident-history", []);
                if (!is_array($deletedRequestIds) || !is_array($residentHistory)) {
                    throw new RuntimeException("Saved resident request history or deletion IDs are invalid.");
                }

                $excludedRequestIds = [];
                foreach ($deletedRequestIds as $deletedRequestId) {
                    if (is_string($deletedRequestId) || is_int($deletedRequestId)) {
                        $excludedRequestIds[(string) $deletedRequestId] = true;
                    }
                }
                foreach ($residentHistory as $historyRecord) {
                    if ($historyRecord instanceof stdClass && isset($historyRecord->id)) {
                        $excludedRequestIds[(string) $historyRecord->id] = true;
                    }
                }

                $incomingRequestIds = [];
                $mergedRequests = [];
                foreach ($records->{$key} as $request) {
                    $requestId = (string) $request->id;
                    if (isset($excludedRequestIds[$requestId])) continue;
                    $incomingRequestIds[$requestId] = true;
                    $mergedRequests[] = $request;
                }
                foreach ($existingRequests as $existingRequest) {
                    if (!($existingRequest instanceof stdClass) || !isset($existingRequest->id)) {
                        throw new RuntimeException("A saved resident request is invalid.");
                    }
                    $existingRequestId = (string) $existingRequest->id;
                    if (isset($incomingRequestIds[$existingRequestId])
                        || isset($excludedRequestIds[$existingRequestId])) {
                        continue;
                    }
                    $mergedRequests[] = $existingRequest;
                }
                $value = json_encode(
                    array_values($mergedRequests),
                    JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
                );
            }
            $statement->execute([$key, $value]);
            if ($key === "bb1-resident-requests") {
                bb1ClearResidentRequestChanges($pdo);
            }
        }
        if ($hasRequestChanges) {
            bb1SaveResidentRequestChanges($pdo, $requestUpserts, array_keys($requestDeleteIds));
        }
        $pdo->commit();
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }

    $savedKeys = array_keys($encodedRecords);
    if ($hasRequestChanges && !in_array("bb1-resident-requests", $savedKeys, true)) {
        $savedKeys[] = "bb1-resident-requests";
    }
    respond(200, ["success" => true, "saved" => $savedKeys]);
} catch (JsonException $e) {
    respond(400, ["success" => false, "message" => "The request or stored record contains invalid JSON."]);
} catch (Throwable $e) {
    error_log("Application data API error: " . $e->getMessage());
    respond(500, ["success" => false, "message" => "Unable to access the application database."]);
}
