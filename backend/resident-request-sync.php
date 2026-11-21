<?php

header("Content-Type: application/json; charset=UTF-8");
header("Cache-Control: no-store, no-cache, must-revalidate, max-age=0");
header("Pragma: no-cache");
header("Expires: 0");

require_once __DIR__ . "/db.php";
require_once __DIR__ . "/auth.php";

function residentSyncRespond(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function residentSyncIsList($value): bool
{
    return is_array($value)
        && (!$value || array_keys($value) === range(0, count($value) - 1));
}

function residentSyncNameKey(string $name): string
{
    $name = function_exists("mb_strtolower")
        ? mb_strtolower($name, "UTF-8")
        : strtolower($name);
    return preg_replace('/[^\p{L}\p{N}]+/u', '', $name) ?? "";
}

function residentSyncRecordBelongsTo($record, string $residentCode, string $fullName): bool
{
    if (!($record instanceof stdClass)) {
        return false;
    }

    $recordCode = $record->residentCode ?? $record->resident_code ?? "";
    if (is_string($recordCode) && trim($recordCode) !== "") {
        return strtoupper(trim($recordCode)) === strtoupper($residentCode);
    }

    $recordName = $record->resident
        ?? $record->name
        ?? $record->fullName
        ?? $record->full_name
        ?? "";

    return is_string($recordName)
        && residentSyncNameKey($recordName) !== ""
        && residentSyncNameKey($recordName) === residentSyncNameKey($fullName);
}

function residentSyncReadState(PDO $pdo, string $key, $fallback = null)
{
    $statement = $pdo->prepare("
        SELECT data_value
        FROM bb1_app_state
        WHERE data_key = ?
        LIMIT 1
    ");
    $statement->execute([$key]);
    $value = $statement->fetchColumn();

    return $value === false
        ? $fallback
        : json_decode($value, false, 512, JSON_THROW_ON_ERROR);
}

function residentSyncOwnedRecords($records, string $residentCode, string $fullName): array
{
    if (!is_array($records)) {
        throw new RuntimeException("Saved resident records must be a list.");
    }

    return array_values(array_filter(
        $records,
        static fn($record) => residentSyncRecordBelongsTo($record, $residentCode, $fullName)
    ));
}

function residentSyncSafeValue($value, string $field, int $maximumBytes)
{
    if (!($value instanceof stdClass) && !is_array($value) && !is_scalar($value) && $value !== null) {
        throw new InvalidArgumentException("Invalid " . $field . ".");
    }

    $encoded = json_encode(
        $value,
        JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
    );
    if (strlen($encoded) > $maximumBytes) {
        throw new InvalidArgumentException($field . " is too large to synchronize.");
    }

    return $value;
}

function residentSyncString($record, string $field, int $maximumLength, bool $required = false): string
{
    $value = $record->{$field} ?? "";
    if (!is_string($value) || strlen($value) > $maximumLength || ($required && trim($value) === "")) {
        throw new InvalidArgumentException("Invalid " . $field . ".");
    }

    return trim($value);
}

function residentSyncCopySubmissionField(stdClass $incoming, stdClass $target, string $field): void
{
    if (!property_exists($incoming, $field)) {
        return;
    }

    $value = $incoming->{$field};
    if ($field === "requirements") {
        if (!residentSyncIsList($value)) {
            throw new InvalidArgumentException("Invalid requirements.");
        }
        foreach ($value as $requirement) {
            if (!is_string($requirement) || strlen($requirement) > 500) {
                throw new InvalidArgumentException("Invalid requirements.");
            }
        }
    } elseif ($value !== null
        && !($value instanceof stdClass)
        && !($field === "philsysVerificationEvidence" && is_string($value))) {
        throw new InvalidArgumentException("Invalid " . $field . ".");
    }

    if ($field === "requirementPhotos" || $field === "philsysVerificationEvidence") {
        residentSyncValidateImageDataUrls($value, $field);
    }

    $target->{$field} = residentSyncSafeValue(
        $value,
        $field,
        in_array($field, ["requirementPhotos", "philsysVerificationEvidence"], true)
            ? 5 * 1024 * 1024
            : 1024 * 1024
    );
}

function residentSyncValidateImageDataUrls($value, string $field): void
{
    if ($value instanceof stdClass) {
        foreach (get_object_vars($value) as $key => $child) {
            if ($key === "dataUrl") {
                if (!is_string($child)
                    || !preg_match('/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+\/=\r\n]+)$/i', $child, $matches)
                    || base64_decode($matches[1], true) === false) {
                    throw new InvalidArgumentException("Invalid image data in " . $field . ".");
                }
                continue;
            }
            residentSyncValidateImageDataUrls($child, $field);
        }
        return;
    }

    if (is_array($value)) {
        foreach ($value as $child) {
            residentSyncValidateImageDataUrls($child, $field);
        }
        return;
    }

    if (is_string($value) && strpos($value, "data:") === 0) {
        if (!preg_match('/^data:image\/(?:jpeg|jpg|png|webp);base64,([A-Za-z0-9+\/=\r\n]+)$/i', $value, $matches)
            || base64_decode($matches[1], true) === false) {
            throw new InvalidArgumentException("Invalid image data in " . $field . ".");
        }
    }
}

function residentSyncValidatedPaymentProof($proof)
{
    if ($proof === null) {
        return null;
    }
    if (!($proof instanceof stdClass)) {
        throw new InvalidArgumentException("Invalid payment proof.");
    }

    residentSyncValidateImageDataUrls($proof, "payment proof");
    return residentSyncSafeValue($proof, "payment proof", 5 * 1024 * 1024);
}

function residentSyncNewRequest(
    stdClass $incoming,
    string $residentCode,
    string $fullName,
    array $allowedDocuments,
    array $documentFees,
    string $now
): stdClass {
    $id = residentSyncString($incoming, "id", 100, true);
    if (!preg_match('/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/', $id)) {
        throw new InvalidArgumentException("A new request has an invalid ID.");
    }

    $documents = $incoming->documents ?? null;
    if (!residentSyncIsList($documents) || !$documents || count($documents) > 8) {
        throw new InvalidArgumentException("Requests must include a valid document list.");
    }

    $copyCount = $incoming->copyCount ?? 1;
    if (!is_int($copyCount) || $copyCount < 1 || $copyCount > 50) {
        throw new InvalidArgumentException("The document copy count is invalid.");
    }

    $validatedDocuments = [];
    $unitFeeAmount = 0.0;
    foreach ($documents as $document) {
        if (!is_string($document) || trim($document) === "" || strlen($document) > 160) {
            throw new InvalidArgumentException("A requested document name is invalid.");
        }
        $document = trim($document);
        if (!in_array($document, $allowedDocuments, true)) {
            throw new InvalidArgumentException("A requested document is not enabled.");
        }
        $validatedDocuments[] = $document;
        $unitFeeAmount += (float) ($documentFees[$document] ?? 0);
    }

    $request = new stdClass();
    $request->id = $id;
    $request->submissionId = residentSyncString($incoming, "submissionId", 100) ?: $id;
    $request->resident = $fullName;
    $request->residentCode = $residentCode;
    $request->documents = array_values(array_unique($validatedDocuments));
    $request->copyCount = $copyCount;
    $request->unitFeeAmount = round($unitFeeAmount, 2);
    $request->feeAmount = round($unitFeeAmount * $copyCount, 2);
    $request->requestedAt = $now;
    $request->status = "New";
    $request->statusHistory = [["status" => "New", "changedAt" => $now]];
    $request->activity = [[
        "action" => "Request submitted",
        "by" => "Resident",
        "time" => gmdate("M j, Y, g:i A"),
    ]];
    $request->paymentStatus = $request->feeAmount > 0 ? "Unpaid" : "Not required";

    foreach ([
        "certificateData",
        "detailsByDocument",
        "details",
        "requirements",
        "requirementPhotos",
        "philsysVerificationEvidence",
    ] as $field) {
        residentSyncCopySubmissionField($incoming, $request, $field);
    }

    if ($request->feeAmount > 0 && (
        ($incoming->paymentStatus ?? "") === "Pending verification"
        || !empty($incoming->paymentProofOrNumber)
        || !empty($incoming->paymentProof)
    )) {
        $paymentProofOrNumber = residentSyncString($incoming, "paymentProofOrNumber", 200);
        $paymentProof = residentSyncValidatedPaymentProof($incoming->paymentProof ?? null);
        $paymentProofDataUrl = $paymentProof instanceof stdClass ? ($paymentProof->dataUrl ?? "") : "";
        if ($paymentProofOrNumber === "" && $paymentProofDataUrl === "") {
            throw new InvalidArgumentException("A receipt image or transaction number is required.");
        }
        $request->paymentStatus = "Pending verification";
        $request->paymentMethod = residentSyncString($incoming, "paymentMethod", 80);
        $request->paymentGroupId = residentSyncString($incoming, "paymentGroupId", 100);
        $request->paymentProofOrNumber = $paymentProofOrNumber;
        $request->paymentProof = $paymentProof;
        $request->paymentSubmittedAt = $now;
        $request->activity[] = [
            "action" => "Payment proof submitted",
            "by" => "Resident",
            "time" => gmdate("M j, Y, g:i A"),
        ];
    }

    return $request;
}

function residentSyncApplyUpdate(stdClass $existing, stdClass $incoming, string $now): stdClass
{
    $updated = clone $existing;
    $status = (string) ($existing->status ?? "New");
    $incomingStatus = (string) ($incoming->status ?? "");
    $canEditSubmission = in_array($status, ["New", "Returned for edits"], true);

    if ($canEditSubmission) {
        foreach ([
            "certificateData",
            "detailsByDocument",
            "details",
            "requirements",
            "requirementPhotos",
            "philsysVerificationEvidence",
        ] as $field) {
            residentSyncCopySubmissionField($incoming, $updated, $field);
        }
    }

    if ($status === "Returned for edits" && $incomingStatus === "For Verification") {
        $updated->status = "For Verification";
        $updated->updatedAt = $now;
        $updated->correctedRequirementsAt = $now;
        $updated->editRequestNote = "";
        $updated->invalidRequirements = [];
        $updated->statusHistory = is_array($updated->statusHistory ?? null)
            ? $updated->statusHistory
            : [];
        $updated->statusHistory[] = ["status" => "For Verification", "changedAt" => $now];
        $updated->activity = is_array($updated->activity ?? null) ? $updated->activity : [];
        $updated->activity[] = [
            "action" => "Corrected requirements resubmitted for review",
            "by" => "Resident",
            "time" => gmdate("M j, Y, g:i A"),
        ];
    } elseif ($status === "New" && $incomingStatus === "Cancelled") {
        $updated->status = "Cancelled";
        $updated->cancelledAt = $now;
        $refundNumber = residentSyncString($incoming, "refundDestinationNumber", 32);
        if ($refundNumber !== "") {
            $normalizedNumber = preg_replace('/[\s()-]/', '', $refundNumber);
            if (!preg_match('/^(?:09\d{9}|\+639\d{9}|639\d{9})$/', $normalizedNumber)) {
                throw new InvalidArgumentException("The refund mobile number is invalid.");
            }
            $updated->refundDestinationNumber = $refundNumber;
        }
        $updated->statusHistory = is_array($updated->statusHistory ?? null)
            ? $updated->statusHistory
            : [];
        $updated->statusHistory[] = ["status" => "Cancelled", "changedAt" => $now];
        $updated->activity = is_array($updated->activity ?? null) ? $updated->activity : [];
        $updated->activity[] = [
            "action" => "Request cancelled by resident before review",
            "by" => "Resident",
            "time" => gmdate("M j, Y, g:i A"),
        ];
    }

    $currentPaymentStatus = (string) ($existing->paymentStatus ?? "Unpaid");
    if (
        (float) ($existing->feeAmount ?? 0) > 0
        && $currentPaymentStatus !== "Paid"
        && ($incoming->paymentStatus ?? "") === "Pending verification"
        && !in_array($status, ["Cancelled", "Completed", "Declined"], true)
    ) {
        $proofNumber = residentSyncString($incoming, "paymentProofOrNumber", 200);
        $proof = residentSyncValidatedPaymentProof($incoming->paymentProof ?? null);
        $proofDataUrl = $proof instanceof stdClass ? ($proof->dataUrl ?? "") : "";
        if ($proofNumber === "" && $proofDataUrl === "") {
            throw new InvalidArgumentException("A receipt image or transaction number is required.");
        }
        $updated->paymentStatus = "Pending verification";
        $updated->paymentMethod = residentSyncString($incoming, "paymentMethod", 80);
        $updated->paymentGroupId = residentSyncString($incoming, "paymentGroupId", 100);
        $updated->paymentProofOrNumber = $proofNumber;
        $updated->paymentProof = $proof;
        $updated->paymentSubmittedAt = $now;
        $updated->activity = is_array($updated->activity ?? null) ? $updated->activity : [];
        $updated->activity[] = [
            "action" => "Payment proof submitted" . ($proofNumber !== "" ? " · " . $proofNumber : ""),
            "by" => "Resident",
            "time" => gmdate("M j, Y, g:i A"),
        ];
    }

    return $updated;
}

$method = $_SERVER["REQUEST_METHOD"] ?? "";
if (!in_array($method, ["GET", "POST"], true)) {
    header("Allow: GET, POST, OPTIONS");
    residentSyncRespond(405, ["success" => false, "message" => "Method not allowed."]);
}

try {
    $user = authenticateUser($pdo, ["resident"]);
    $pdo->exec("
        CREATE TABLE IF NOT EXISTS bb1_app_state (
            data_key VARCHAR(100) NOT NULL PRIMARY KEY,
            data_value LONGTEXT NOT NULL,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    ");
    $residentStatement = $pdo->prepare("
        SELECT
            r.resident_code,
            r.first_name,
            r.middle_name,
            r.last_name,
            r.suffix,
            u.full_name
        FROM residents r
        INNER JOIN users u ON u.id = r.user_id
        WHERE r.user_id = ?
          AND r.record_status = 'active'
        LIMIT 1
    ");
    $residentStatement->execute([$user["id"]]);
    $resident = $residentStatement->fetch(PDO::FETCH_ASSOC);

    if (!$resident) {
        residentSyncRespond(404, ["success" => false, "message" => "Active resident profile not found."]);
    }

    $residentCode = strtoupper(trim((string) $resident["resident_code"]));
    $fullName = trim((string) $resident["full_name"]);
    if ($residentCode === "" || $fullName === "") {
        residentSyncRespond(409, ["success" => false, "message" => "Resident account details are incomplete."]);
    }

    $allowedDocuments = [
        "Barangay Clearance",
        "Business Clearance",
        "Certificate of Appearance",
        "Certificate of Business Closure",
        "Certificate of Indigency",
        "Certificate of Residency",
        "Income Certification",
        "Permit to Construct",
        "Solo Parent Certification",
    ];
    $enabledDocuments = residentSyncReadState($pdo, "bb1-enabled-certificate-types");
    if ($enabledDocuments !== null) {
        if (!residentSyncIsList($enabledDocuments)
            || !array_reduce($enabledDocuments, static fn($valid, $document) => $valid && is_string($document), true)) {
            throw new RuntimeException("Enabled document types are not a valid list.");
        }
        $allowedDocuments = $enabledDocuments;
    }
    if ($enabledDocuments === null) {
        $templates = residentSyncReadState($pdo, "bb1-certificate-templates", []);
        if (is_array($templates)) {
            foreach ($templates as $template) {
                if ($template instanceof stdClass
                    && ($template->enabled ?? true) !== false
                    && isset($template->name)
                    && is_string($template->name)) {
                    $allowedDocuments[] = $template->name;
                }
            }
        }
    }
    $allowedDocuments = array_values(array_unique($allowedDocuments));

    $documentFees = residentSyncReadState($pdo, "bb1-document-fees", new stdClass());
    if (!($documentFees instanceof stdClass)) {
        throw new RuntimeException("Saved document fees are not a valid map.");
    }
    $defaultFees = [
        "Barangay Clearance" => 50,
        "Business Clearance" => 200,
        "Certificate of Appearance" => 30,
        "Certificate of Business Closure" => 100,
        "Certificate of Residency" => 50,
        "Income Certification" => 50,
    ];
    $documentFees = array_merge($defaultFees, get_object_vars($documentFees));
    foreach ($documentFees as $document => $fee) {
        if (!is_numeric($fee) || (float) $fee < 0 || (float) $fee > 100000) {
            throw new RuntimeException("A saved document fee is invalid.");
        }
        $documentFees[$document] = (float) $fee;
    }

    $history = residentSyncOwnedRecords(
        residentSyncReadState($pdo, "bb1-resident-history", []),
        $residentCode,
        $fullName
    );

    if ($method === "GET") {
        $requests = residentSyncOwnedRecords(
            residentSyncReadState($pdo, "bb1-resident-requests", []),
            $residentCode,
            $fullName
        );
        residentSyncRespond(200, [
            "success" => true,
            "data" => [
                "requests" => $requests,
                "history" => $history,
            ],
        ]);
    }

    $body = file_get_contents("php://input");
    if ($body === false || $body === "") {
        residentSyncRespond(400, ["success" => false, "message" => "A request list is required."]);
    }
    if (strlen($body) > 12 * 1024 * 1024) {
        residentSyncRespond(413, ["success" => false, "message" => "Resident request data is too large to synchronize."]);
    }

    try {
        $input = json_decode($body, false, 512, JSON_THROW_ON_ERROR);
    } catch (JsonException $error) {
        residentSyncRespond(400, ["success" => false, "message" => "Invalid JSON request."]);
    }
    if (!($input instanceof stdClass)
        || array_diff(array_keys(get_object_vars($input)), ["requests"])
        || !property_exists($input, "requests")
        || !residentSyncIsList($input->requests)
        || count($input->requests) > 200) {
        residentSyncRespond(400, ["success" => false, "message" => "A valid resident request list is required."]);
    }

    $incomingIds = [];
    foreach ($input->requests as $incoming) {
        if (!($incoming instanceof stdClass)) {
            residentSyncRespond(422, ["success" => false, "message" => "Each request must be an object."]);
        }
        $id = residentSyncString($incoming, "id", 100, true);
        if (isset($incomingIds[$id])) {
            residentSyncRespond(422, ["success" => false, "message" => "Duplicate request IDs were submitted."]);
        }
        $incomingIds[$id] = true;
        if (!residentSyncRecordBelongsTo($incoming, $residentCode, $fullName)) {
            residentSyncRespond(403, ["success" => false, "message" => "A request does not belong to this resident account."]);
        }
    }

    $pdo->beginTransaction();
    try {
        $ensureRequestState = $pdo->prepare("
            INSERT IGNORE INTO bb1_app_state (data_key, data_value)
            VALUES (?, '[]')
        ");
        $ensureRequestState->execute(["bb1-resident-requests"]);

        $ensureHistoryState = $pdo->prepare("
            INSERT IGNORE INTO bb1_app_state (data_key, data_value)
            VALUES (?, '[]')
        ");
        $ensureHistoryState->execute(["bb1-resident-history"]);

        $lock = $pdo->prepare("
            SELECT data_value
            FROM bb1_app_state
            WHERE data_key = ?
            LIMIT 1
            FOR UPDATE
        ");
        $lock->execute(["bb1-resident-requests"]);
        $savedJson = $lock->fetchColumn();
        $allRequests = json_decode($savedJson, false, 512, JSON_THROW_ON_ERROR);
        if (!residentSyncIsList($allRequests)) {
            throw new RuntimeException("Saved resident requests are not a list.");
        }

        $historyLock = $pdo->prepare("
            SELECT data_value
            FROM bb1_app_state
            WHERE data_key = ?
            LIMIT 1
            FOR UPDATE
        ");
        $historyLock->execute(["bb1-resident-history"]);
        $savedHistoryJson = $historyLock->fetchColumn();
        $history = residentSyncOwnedRecords(
            json_decode($savedHistoryJson, false, 512, JSON_THROW_ON_ERROR),
            $residentCode,
            $fullName
        );

        $existingIndexes = [];
        foreach ($allRequests as $index => $record) {
            if (!($record instanceof stdClass)) {
                throw new RuntimeException("A saved resident request is invalid.");
            }
            $recordId = $record->id ?? null;
            if (is_string($recordId) && $recordId !== "") {
                $existingIndexes[$recordId] = $index;
            }
        }

        $archivedIds = [];
        foreach ($history as $record) {
            $recordId = $record->id ?? null;
            if (is_string($recordId) && $recordId !== "") {
                $archivedIds[$recordId] = true;
            }
        }

        $now = gmdate("c");
        foreach ($input->requests as $incoming) {
            $id = $incoming->id;
            if (isset($archivedIds[$id])) {
                continue;
            }

            if (isset($existingIndexes[$id])) {
                $index = $existingIndexes[$id];
                $existing = $allRequests[$index];
                if (!residentSyncRecordBelongsTo($existing, $residentCode, $fullName)) {
                    throw new DomainException("A request ID is already in use.");
                }
                $allRequests[$index] = residentSyncApplyUpdate($existing, $incoming, $now);
                continue;
            }

            $newRequest = residentSyncNewRequest(
                $incoming,
                $residentCode,
                $fullName,
                $allowedDocuments,
                $documentFees,
                $now
            );
            $existingIndexes[$id] = count($allRequests);
            $allRequests[] = $newRequest;
        }

        $encodedRequests = json_encode(
            array_values($allRequests),
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR
        );
        $update = $pdo->prepare("
            UPDATE bb1_app_state
            SET data_value = ?
            WHERE data_key = ?
        ");
        $update->execute([$encodedRequests, "bb1-resident-requests"]);
        $pdo->commit();

        $ownRequests = residentSyncOwnedRecords($allRequests, $residentCode, $fullName);
        residentSyncRespond(200, [
            "success" => true,
            "data" => [
                "requests" => $ownRequests,
                "history" => $history,
            ],
        ]);
    } catch (Throwable $error) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $error;
    }
} catch (DomainException $error) {
    residentSyncRespond(409, ["success" => false, "message" => $error->getMessage()]);
} catch (InvalidArgumentException $error) {
    residentSyncRespond(422, ["success" => false, "message" => $error->getMessage()]);
} catch (Throwable $error) {
    error_log("Resident request sync error: " . $error->getMessage());
    residentSyncRespond(500, ["success" => false, "message" => "Resident requests could not be synchronized."]);
}
