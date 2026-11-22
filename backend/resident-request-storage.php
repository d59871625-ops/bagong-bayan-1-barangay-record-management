<?php

function bb1EnsureResidentRequestChangesTable(PDO $pdo): void
{
    static $ensured = false;
    if ($ensured) {
        return;
    }

    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_resident_request_changes (
            request_id VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
            data_value LONGTEXT NULL,
            is_deleted TINYINT(1) NOT NULL DEFAULT 0,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    $ensured = true;
}

function bb1LoadResidentRequestChanges(PDO $pdo): array
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $statement = $pdo->query("
        SELECT request_id, data_value, is_deleted
        FROM bb1_resident_request_changes
        ORDER BY request_id
    ");
    return $statement->fetchAll(PDO::FETCH_ASSOC);
}

function bb1LoadResidentRequestChangesForAdmin(PDO $pdo): array
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $statement = $pdo->query("
        SELECT
            request_id,
            CASE WHEN is_deleted = 0 AND data_value IS NOT NULL
                THEN JSON_REMOVE(data_value, '$.requirementPhotos', '$.philsysVerificationEvidence')
                ELSE NULL
            END AS data_value,
            is_deleted,
            CASE WHEN is_deleted = 0 AND data_value IS NOT NULL
                THEN JSON_CONTAINS_PATH(data_value, 'one', '$.requirementPhotos', '$.philsysVerificationEvidence')
                ELSE 0
            END AS has_evidence
        FROM bb1_resident_request_changes
        ORDER BY request_id
    ");
    return $statement->fetchAll(PDO::FETCH_ASSOC);
}

function bb1MergeResidentRequestChanges($baseRequests, array $changes): array
{
    if (!is_array($baseRequests)) {
        throw new RuntimeException("Saved resident requests are not a list.");
    }

    $requestsById = [];
    $requestIds = [];
    foreach ($baseRequests as $request) {
        if (!($request instanceof stdClass) || !isset($request->id)) {
            throw new RuntimeException("A saved resident request is invalid.");
        }
        $requestId = (string) $request->id;
        if (!array_key_exists($requestId, $requestsById)) {
            $requestIds[] = $requestId;
        }
        $requestsById[$requestId] = $request;
    }

    foreach ($changes as $change) {
        $requestId = (string) ($change["request_id"] ?? "");
        if ($requestId === "") {
            throw new RuntimeException("A saved resident request change is invalid.");
        }
        if ((int) ($change["is_deleted"] ?? 0) === 1) {
            unset($requestsById[$requestId]);
            continue;
        }

        $request = json_decode((string) ($change["data_value"] ?? ""), false, 512, JSON_THROW_ON_ERROR);
        if (!($request instanceof stdClass)
            || !isset($request->id)
            || (string) $request->id !== $requestId) {
            throw new RuntimeException("A saved resident request change is invalid.");
        }
        if (!array_key_exists($requestId, $requestsById)) {
            $requestIds[] = $requestId;
        }
        $requestsById[$requestId] = $request;
    }

    return array_values(array_map(
        static fn(string $requestId) => $requestsById[$requestId],
        array_values(array_filter($requestIds, static fn(string $requestId) => array_key_exists($requestId, $requestsById)))
    ));
}

function bb1SaveResidentRequestChanges(PDO $pdo, array $upserts, array $deletedIds): void
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $statement = $pdo->prepare("
        INSERT INTO bb1_resident_request_changes (request_id, data_value, is_deleted)
        VALUES (?, ?, ?)
        ON DUPLICATE KEY UPDATE
            data_value = VALUES(data_value),
            is_deleted = VALUES(is_deleted)
    ");

    foreach ($upserts as $request) {
        $requestId = (string) $request->id;
        $encodedRequest = json_encode(
            $request,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
        $statement->execute([$requestId, $encodedRequest, 0]);
    }

    foreach ($deletedIds as $requestId) {
        $statement->execute([$requestId, null, 1]);
    }
}

function bb1ClearResidentRequestChanges(PDO $pdo): void
{
    bb1EnsureResidentRequestChangesTable($pdo);
    $pdo->exec("DELETE FROM bb1_resident_request_changes");
}
