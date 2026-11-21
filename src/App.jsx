import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PDFDocument } from 'pdf-lib'
import barangaySeal from './brgy.png'
import barangayHall from './bb1.jpeg'
import {
  ageFromBirthDate,
  CERTIFICATE_EDITOR_PAGE_SIZES,
  createFilledCertificateDocx,
  downloadFilledCertificateDocx,
  getCertificateTemplate,
  getCertificateTemplateFields,
  getCertificateTemplateHeaderArtwork,
  groupCertificateTemplateFields,
  getDefaultCertificateData,
  getDefaultRequestCertificates,
  normalizeBarangayZone,
  normalizeCertificateTemplateHeader,
  readCertificateTemplateForEditing,
  scanCertificateTemplateFields,
  updateCertificateTemplateDocx,
} from './certificateDocuments.js'
import './App.css'

const isLoopbackApiUrl = (value) => /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)
const configuredBackendApiUrl = import.meta.env.VITE_BACKEND_API_URL?.trim()
const configuredApiUrl = import.meta.env.VITE_API_URL?.trim()
const DATABASE_REFRESH_INTERVAL_MS = 5000
const productionBackendApiUrl = `${window.location.origin}/backend`
const BACKEND_API_URL = configuredBackendApiUrl && (!import.meta.env.PROD || !isLoopbackApiUrl(configuredBackendApiUrl))
  ? configuredBackendApiUrl
  : import.meta.env.PROD ? productionBackendApiUrl : 'http://127.0.0.1:8000'
const API_URL = configuredApiUrl && (!import.meta.env.PROD || !isLoopbackApiUrl(configuredApiUrl))
  ? configuredApiUrl
  : `${BACKEND_API_URL}/api.php`
const PUBLIC_COMMUNITY_API_URL = `${BACKEND_API_URL}/public-community.php`
const RESIDENT_REQUEST_SYNC_URL = `${BACKEND_API_URL}/resident-request-sync.php`
const EMPTY_CERTIFICATE_TEMPLATES = Object.freeze([])
const CERTIFICATE_PDF_URL = import.meta.env.VITE_CERTIFICATE_PDF_URL?.trim()
  || API_URL.replace(/\/api\.php$/, '/certificate-to-pdf.php')

const readJsonResponse = async (response, endpointName) => {
  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch {
    const contentType = response.headers.get('content-type') || ''
    const responseType = contentType.includes('text/html') || /^\s*</.test(body)
      ? 'an HTML error page'
      : 'an invalid response'
    throw new Error(`${endpointName} returned ${responseType} instead of JSON (HTTP ${response.status}).`)
  }
}

const fetchWithTimeout = async (url, options = {}, timeoutMs = DATABASE_REFRESH_INTERVAL_MS) => {
  const { signal: externalSignal, ...requestOptions } = options
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = () => controller.abort()
  if (externalSignal?.aborted) {
    controller.abort()
  } else {
    externalSignal?.addEventListener('abort', abortFromCaller, { once: true })
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(url, { ...requestOptions, signal: controller.signal })
  } catch (error) {
    if (timedOut && !externalSignal?.aborted) {
      throw new Error(
        `The server request timed out after ${timeoutMs / 1000} seconds.`,
        { cause: error },
      )
    }
    throw error
  } finally {
    window.clearTimeout(timeoutId)
    externalSignal?.removeEventListener('abort', abortFromCaller)
  }
}

const saveDatabaseRecords = async (records, backendToken) => {
  if (!backendToken) {
    throw new Error('Sign in with an active backend administrator account before saving shared records.')
  }
  const response = await fetchWithTimeout(API_URL, {
    method: 'POST',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${backendToken}`,
    },
    body: JSON.stringify({ records }),
  })
  const result = await readJsonResponse(response, 'Database save')
  if (!response.ok || !result.success) {
    throw new Error(result.message || `Database save failed with status ${response.status}.`)
  }
}

const queueDatabaseRecords = (queueRef, records, backendToken) => {
  const save = queueRef.current.catch(() => {}).then(() => saveDatabaseRecords(records, backendToken))
  queueRef.current = save.catch(() => {})
  return save
}

const barangayDocuments = [
  'Barangay Clearance',
  'Business Clearance',
  'Certificate of Appearance',
  'Certificate of Business Closure',
  'Certificate of Indigency',
  'Certificate of Residency',
  'Income Certification',
  'Permit to Construct',
  'Solo Parent Certification',
]

const documentRequirements = {
  'Barangay Clearance': ['Valid government ID', 'Proof of residency'],
  'Business Clearance': ['Valid government ID', 'Business permit or registration', 'Proof of business address'],
  'Certificate of Appearance': ['Valid government ID', 'Reason for appearance certificate'],
  'Certificate of Business Closure': ['Valid government ID', 'Business permit or registration', 'Proof of business address'],
  'Certificate of Indigency': ['Valid government ID', 'Proof of residency'],
  'Certificate of Residency': ['Valid government ID', 'Proof of residency'],
  'Income Certification': ['Valid government ID', 'Proof of income'],
  'Permit to Construct': ['Valid government ID', 'Proof of ownership or authorization', 'Construction plan'],
  'Solo Parent Certification': ['Valid government ID', 'Proof of solo parent status'],
}
const certificateTemplatesStorageKey = 'bb1-certificate-templates'
const createCustomCertificateTemplateId = () => `custom-template-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const getDocumentRequirements = (document, customTemplates = []) => (
  customTemplates.find((template) => template.name === document)?.requirements
  || documentRequirements[document]
  || []
)
const getCertificateFieldValue = (details, field) => (
  [details?.[field.key], ...(field.targets || []).map((target) => details?.[target.key])]
    .find((value) => value !== false && String(value ?? '').trim())
)
const hasCertificateFieldValue = (details, field) => {
  const value = getCertificateFieldValue(details, field)
  if (Array.isArray(value)) return value.some((item) => String(item ?? '').trim())
  return value !== undefined && value !== null && String(value).trim() !== ''
}
const getDisplayCertificateFieldValue = (value) => Array.isArray(value) ? value.join(', ') : value

function ResidentDocumentIcon({ document, className = '' }) {
  const icon = {
    'Barangay Clearance': <><path d="M16 3 26 7v7c0 6-4 11-10 15C10 25 6 20 6 14V7l10-4Z" /><path d="m11.5 15.5 3 3 6-7" /></>,
    'Business Clearance': <><path d="M5 13h22v14H5zM8 13V8l3-3h10l3 3v5" /><path d="M8 13v4h5v-4M19 13v4h5v-4M11 27v-6h10v6" /></>,
    'Certificate of Appearance': <><circle cx="13" cy="10" r="5" /><path d="M4 27c.8-5 4-8 9-8 2 0 3.8.5 5.2 1.5" /><circle cx="23" cy="22" r="6" /><path d="M23 18.5V22l2.5 1.5" /></>,
    'Certificate of Business Closure': <><path d="M5 13h22v14H5zM8 13V8l3-3h10l3 3v5" /><path d="M11 20h10M10 26l12-12" /></>,
    'Certificate of Indigency': <><path d="M16 27S5 20 5 12a6 6 0 0 1 11-3 6 6 0 0 1 11 3c0 8-11 15-11 15Z" /><path d="M10 17h3l2-3 3 6 2-3h2" /></>,
    'Certificate of Residency': <><path d="m4 14 12-10 12 10" /><path d="M7 12v15h18V12M13 27v-9h6v9" /><path d="M20 6h4v4" /></>,
    'Income Certification': <><rect x="4" y="7" width="24" height="19" rx="3" /><path d="M4 12h24M9 19h5M21 5v4" /><circle cx="22" cy="20" r="3" /></>,
    'Permit to Construct': <><path d="m4 15 12-10 12 10M7 13v14h18V13M13 27v-9h6v9" /><path d="m21 7 3-3M20 5l3 3M5 20l5-5" /></>,
    'Solo Parent Certification': <><circle cx="12" cy="10" r="4" /><circle cx="23" cy="16" r="3" /><path d="M4 27c.5-5 3.3-8 8-8 3.3 0 5.6 1.5 6.8 4M19 27c.3-3 1.7-5 4-5s3.7 2 4 5" /><path d="m9 10 2 2 4-5" /></>,
  }[document]

  return <svg className={className} viewBox="0 0 32 32" fill="none" focusable="false" aria-hidden="true">
    <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{icon || <><path d="M8 4h11l6 6v18H8z" /><path d="M19 4v7h6M12 17h9M12 21h7" /></>}</g>
  </svg>
}

const loadResidentRequests = () => {
  try {
    const storedTemplates = readStoredList(certificateTemplatesStorageKey, [])
    const savedRequests = window.localStorage.getItem(residentRequestsStorageKey)
    if (!savedRequests) return splitMultiDocumentRequests(initialRequests.map(withRequestStatusHistory), storedTemplates)
    const parsedRequests = JSON.parse(savedRequests)
    if (!Array.isArray(parsedRequests)) throw new Error('Saved resident requests must be a list.')
    return splitMultiDocumentRequests(parsedRequests.map(withRequestStatusHistory), storedTemplates)
  } catch (error) {
    console.error('Unable to load resident requests from browser storage.', error)
    return splitMultiDocumentRequests(initialRequests.map(withRequestStatusHistory), readStoredList(certificateTemplatesStorageKey, []))
  }
}

const philsysEvidencePhotoKey = 'philsys-verification-evidence'

const createRequirementPhoto = async (file) => {
  if (!file?.type.startsWith('image/')) throw new Error('Choose a valid image file.')
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.')

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height))
  const canvas = window.document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('The image could not be prepared for review.')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const compressedPhoto = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('The image could not be compressed for upload.'))
    }, 'image/jpeg', 0.86)
  })
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The image could not be read for upload.'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(new Error('The image could not be read for upload.'))
    reader.readAsDataURL(compressedPhoto)
  })

  return { fileName: file.name, mediaType: compressedPhoto.type, dataUrl }
}

const createCommunityUpdateImage = async (file) => {
  if (!file?.type.startsWith('image/')) throw new Error('Choose a valid image file.')
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.')

  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = window.document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bitmap.width * scale))
  canvas.height = Math.max(1, Math.round(bitmap.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    bitmap.close()
    throw new Error('The image could not be prepared for upload.')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const compressedImage = await new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('The image could not be compressed for upload.'))
    }, 'image/jpeg', 0.84)
  })
  if (compressedImage.size > 1.5 * 1024 * 1024) {
    throw new Error('The image is still too large after compression. Choose a smaller image.')
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The image could not be read for upload.'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(new Error('The image could not be read for upload.'))
    reader.readAsDataURL(compressedImage)
  })
  return { fileName: file.name, mediaType: compressedImage.type, dataUrl }
}

const MAX_GCASH_QR_IMAGE_SIZE = 700 * 1024
const MAX_GCASH_QR_DATA_URL_SIZE = 1000000
const MAX_GCASH_QR_TOTAL_DATA_URL_SIZE = 1400000

const createGcashQrImage = async (file) => {
  const allowedTypes = new Set(['image/png', 'image/jpeg', 'image/webp'])
  if (!file || !allowedTypes.has(file.type)) {
    throw new Error('Choose a PNG, JPEG, or WebP QR image.')
  }
  if (file.size > MAX_GCASH_QR_IMAGE_SIZE) {
    throw new Error('Choose a QR image smaller than 700 KB.')
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The QR image could not be read.'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(new Error('The QR image could not be read.'))
    reader.readAsDataURL(file)
  })

  return { fileName: file.name, mediaType: file.type, dataUrl }
}

const isValidGcashQrImage = (image) => (
  image == null
  || (typeof image === 'object'
    && typeof image.fileName === 'string'
    && ['image/png', 'image/jpeg', 'image/webp'].includes(image.mediaType)
    && typeof image.dataUrl === 'string'
    && image.dataUrl.length <= MAX_GCASH_QR_DATA_URL_SIZE
    && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUrl))
)

const isValidGcashRecipientList = (recipients) => {
  if (!Array.isArray(recipients)) return false
  const totalQrImageSize = recipients.reduce((total, recipient) => (
    total + (typeof recipient?.qrImage?.dataUrl === 'string' ? recipient.qrImage.dataUrl.length : 0)
  ), 0)
  return totalQrImageSize <= MAX_GCASH_QR_TOTAL_DATA_URL_SIZE
    && recipients.every((recipient) => (
      recipient && typeof recipient.id === 'string'
      && typeof recipient.displayName === 'string'
      && typeof recipient.mobileNumber === 'string'
      && isValidGcashQrImage(recipient.qrImage)
    ))
}

const createOfficialPortrait = async (file) => {
  if (!file?.type.startsWith('image/')) throw new Error('Choose a valid image file.')
  if (file.size > 15 * 1024 * 1024) throw new Error('Choose an image smaller than 15 MB.')

  const bitmap = await createImageBitmap(file)
  let compressedPortrait
  try {
    const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height))
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('The photo could not be prepared for saving.')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    compressedPortrait = await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob)
        else reject(new Error('The photo could not be compressed for saving.'))
      }, 'image/jpeg', 0.76)
    })
  } finally {
    bitmap.close()
  }
  if (compressedPortrait.size > 900 * 1024) {
    throw new Error('The photo is still too large after compression. Choose a smaller image.')
  }

  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('The photo could not be read for saving.'))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(new Error('The photo could not be read for saving.'))
    reader.readAsDataURL(compressedPortrait)
  })
  return dataUrl
}

const createRegistrationEvidence = async (file) => {
  if (!file) throw new Error('Upload both a valid ID and proof of residence.')
  if (file.type.startsWith('image/')) {
    const evidence = await createCommunityUpdateImage(file)
    if (evidence.dataUrl.length > 500000) {
      throw new Error(`${file.name} is too large to store with the registration. Choose a smaller image.`)
    }
    return evidence
  }
  if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error(`${file.name} is not a supported image or PDF file.`)
  }
  if (file.size > 375 * 1024) {
    throw new Error(`${file.name} is too large to store with the registration. Use a PDF smaller than 375 KB.`)
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`The ${file.name} PDF could not be read.`))
        return
      }
      resolve(reader.result)
    }
    reader.onerror = () => reject(new Error(`The ${file.name} PDF could not be read.`))
    reader.readAsDataURL(file)
  })
  return { fileName: file.name, mediaType: 'application/pdf', dataUrl }
}

function withRequestStatusHistory(request) {
  if (Array.isArray(request.statusHistory) && request.statusHistory.length) {
    const submittedAt = request.requestedAt || request.date || ''
    const rawStatusHistory = request.statusHistory.map((entry) => (
      entry.status === 'New' && !entry.changedAt && submittedAt
        ? { ...entry, changedAt: submittedAt }
        : entry
    ))
    const wasAutoSubmittedForVerification = request.status === 'For Verification'
      && rawStatusHistory.length === 2
      && rawStatusHistory[0].status === 'New'
      && rawStatusHistory[1].status === 'For Verification'
      && request.activity?.length === 1
      && request.activity[0].action === 'Request submitted'
    if (wasAutoSubmittedForVerification) {
      return { ...request, status: 'New', statusHistory: [rawStatusHistory[0]] }
    }
    const statusHistory = rawStatusHistory.map((entry) => entry.status === 'For Verification'
      ? { ...entry, status: 'Under review' }
      : entry)
    const approval = statusHistory.find((entry) => entry.status === 'Approved - scheduling')
    const hasPreparedDocuments = request.status === 'Approved - scheduling' && request.printCompletedAt
    const normalizedStatusHistory = hasPreparedDocuments && !statusHistory.some((entry) => entry.status === 'Ready for release')
      ? [...statusHistory, { status: 'Ready for release', changedAt: request.printCompletedAt }]
      : statusHistory
    return {
      ...request,
      ...(hasPreparedDocuments ? { status: 'Ready for release' } : request.status === 'For Verification' ? { status: 'Under review' } : {}),
      ...(!request.documentsApprovedAt && approval ? { documentsApprovedAt: approval.changedAt || submittedAt || 'legacy-approved' } : {}),
      statusHistory: normalizedStatusHistory,
    }
  }

  const statusHistory = []
  const activities = request.activity || []
  activities.forEach((entry) => {
    const action = entry.action.toLowerCase()
    let status
    if (action.includes('request submitted')) status = 'New'
    else if (action.includes('set for review') || action.includes('start verification') || action.includes('status changed to under review')) status = 'Under review'
    else if (action.includes('status changed to ready for release')) status = 'Ready for release'
    else if (action.includes('status changed to completed')) status = 'Completed'
    else if (action.includes('status changed to declined') || action.includes('request declined')) status = 'Declined'
    else if (action.includes('edits requested:')) status = 'Returned for edits'
    else if (action.includes('approved and forwarded to scheduling') || action.includes('approved and forwarded to document processing')) status = 'Approved - scheduling'
    if (!status) return
    const parsedTime = new Date(entry.time)
    const changedAt = Number.isNaN(parsedTime.getTime()) ? request.requestedAt || request.date || '' : parsedTime.toISOString()
    statusHistory.push({ status, changedAt })
  })

  if (!statusHistory.length) {
    const submittedAt = request.requestedAt || request.date || ''
    statusHistory.push({ status: request.status === 'For Verification' ? 'Under review' : request.status || 'New', changedAt: submittedAt })
  } else if (statusHistory[statusHistory.length - 1].status !== (request.status === 'For Verification' ? 'Under review' : request.status)) {
    const parsedTime = new Date(activities[activities.length - 1]?.time)
    const changedAt = Number.isNaN(parsedTime.getTime()) ? request.requestedAt || request.date || '' : parsedTime.toISOString()
    statusHistory.push({ status: request.status === 'For Verification' ? 'Under review' : request.status, changedAt })
  }

  const approval = statusHistory.find((entry) => entry.status === 'Approved - scheduling')
  const preparedStatus = request.status === 'Approved - scheduling' && request.printCompletedAt
    ? 'Ready for release'
    : request.status === 'For Verification' ? 'Under review' : request.status || 'New'
  if (preparedStatus === 'Ready for release' && !statusHistory.some((entry) => entry.status === 'Ready for release')) {
    statusHistory.push({ status: 'Ready for release', changedAt: request.printCompletedAt })
  }
  return {
    ...request,
    status: preparedStatus,
    statusHistory,
    ...(approval ? { documentsApprovedAt: approval.changedAt || request.requestedAt || 'legacy-approved' } : {}),
  }
}

const getRequestPhotos = (request) => Object.entries(request.requirementPhotos || {})
  .filter(([photoKey]) => !/philsys-verification-evidence/i.test(photoKey))
  .map(([photoKey, photo]) => {
    const dataUrl = typeof photo === 'string' ? photo : photo?.dataUrl || photo?.dataURL || photo?.src
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null
    const [documentKey, ...photoLabelParts] = photoKey.split('__')
    const namespaced = photoLabelParts.length > 0
    const displayKey = namespaced ? photoLabelParts.join('__') : photoKey
    return {
      photoKey,
      document: namespaced ? documentKey.replace(/-/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) : '',
      label: displayKey
        .replace(/[-_]/g, ' ')
        .replace(/\b(id)\b/gi, 'ID')
        .replace(/\b(front|back)\b/gi, (_, side) => `${side[0].toUpperCase()}${side.slice(1).toLowerCase()}`)
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
        .replace(/\bID (Front|Back)\b/g, 'ID - $1'),
      fileName: typeof photo === 'object' ? photo.fileName : '',
      dataUrl,
    }
  })
  .filter(Boolean)

const getResidentRequestPhotos = (request, relatedRequests = [], customTemplates = []) => {
  const document = request.documents?.[0]
  const requiredPhotoKeys = document
    ? getDocumentRequirements(document, customTemplates).flatMap((requirement) => getRequirementPhotoKeys(requirement))
    : []
  const residentCode = String(request.residentCode || '').trim().toLowerCase()
  const residentName = String(request.resident || '').trim().toLowerCase()
  const sameSubmissionRequests = request.submissionId
    ? relatedRequests.filter((candidate) => (
      candidate !== request
      && (!request.id || candidate.id !== request.id)
      && candidate.submissionId === request.submissionId
      && (
        (residentCode && candidate.residentCode && String(candidate.residentCode).trim().toLowerCase() === residentCode)
        || (residentName && candidate.resident && String(candidate.resident).trim().toLowerCase() === residentName)
      )
    ))
    : []
  const sourceRequests = [request, ...sameSubmissionRequests]
  const photosByRequirement = new Map()

  sourceRequests.forEach((sourceRequest) => {
    getRequestPhotos(sourceRequest).forEach((photo) => {
      const separator = photo.photoKey.indexOf('__')
      const requirementKey = separator >= 0 ? photo.photoKey.slice(separator + 2) : photo.photoKey
      if (requiredPhotoKeys.includes(requirementKey) && !photosByRequirement.has(requirementKey)) {
        photosByRequirement.set(requirementKey, photo)
      }
    })
  })

  const uploadedPhotos = requiredPhotoKeys.flatMap((photoKey) => {
    const photo = photosByRequirement.get(photoKey)
    if (!photo) return []
    return [{ ...photo, key: `${getDocumentPhotoKey(document, photoKey)}` }]
  })
  if (!requiredPhotoKeys.length) {
    uploadedPhotos.push(...getRequestPhotos(request).map((photo) => ({ ...photo, key: photo.photoKey })))
  } else {
    const includedPhotoKeys = new Set(uploadedPhotos.map((photo) => photo.photoKey))
    uploadedPhotos.push(...getRequestPhotos(request)
      .filter((photo) => !includedPhotoKeys.has(photo.photoKey))
      .map((photo) => ({ ...photo, key: photo.photoKey })))
  }

  if (getDocumentRequirements(document, customTemplates).includes('Valid government ID')) {
    const philsysEvidence = sourceRequests.find((sourceRequest) => {
      const evidence = sourceRequest.philsysVerificationEvidence
      const evidenceDataUrl = typeof evidence === 'string' ? evidence : evidence?.dataUrl
      return typeof evidenceDataUrl === 'string' && evidenceDataUrl.startsWith('data:image/')
    })?.philsysVerificationEvidence
    const dataUrl = typeof philsysEvidence === 'string' ? philsysEvidence : philsysEvidence?.dataUrl
    if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
      uploadedPhotos.push({
        key: `${getDocumentPhotoKey(document, 'philsys-verification')}`,
        label: 'PhilSys verification evidence',
        fileName: typeof philsysEvidence === 'object' ? philsysEvidence.fileName || '' : '',
        dataUrl,
      })
    }
  }
  return uploadedPhotos
}

const isAssistanceTypeField = (field) => (
  field.key === 'assistanceType'
  || /\b(?:type|kind|nature)\s+of\s+(?:assistance|aid|support)\b|\b(?:assistance|aid|support)\s+type\b|\b(?:uri|klase)\s+ng\s+tulong\b/i.test(field.label || '')
)

const isPurposeCertificateField = (field) => (
  ['purpose', 'issuePurpose', 'assistanceType', 'businessType', 'soloParentReason'].includes(field.key)
  || /\bpurpose\b/i.test(field.label)
  || isAssistanceTypeField(field)
)

const hasPurposeCertificateField = (fields) => fields.some(isPurposeCertificateField)

const normalizePurposeValue = (value) => (
  (Array.isArray(value) ? value : [value])
    .map((item) => typeof item === 'string' || typeof item === 'number' ? String(item).trim() : '')
    .filter(Boolean)
    .join(', ')
)

const getNormalizedRequestPurpose = (details, fields) => {
  const knownPurposeKeys = ['issuePurpose', 'assistanceType', 'businessType', 'soloParentReason']
  const fieldValues = fields
    .filter(isPurposeCertificateField)
    .map((field) => details[field.key])
  const candidates = [
    ...knownPurposeKeys.map((key) => details[key]),
    ...fieldValues,
    details.purpose,
  ]
  return candidates.map(normalizePurposeValue).find(Boolean) || ''
}

const formatCertificateReviewValue = (value) => (
  Array.isArray(value) ? value.filter(Boolean).join(', ') : value || 'Not provided'
)

const getDocumentPhotoKey = (document, requirementKey) => `${document.replace(/\W+/g, '-').toLowerCase()}__${requirementKey}`
const getRequirementPhotoKeys = (requirement) => {
  const requirementKey = requirement.replace(/\W+/g, '-').toLowerCase()
  return requirement === 'Valid government ID'
    ? [`${requirementKey}-front`, `${requirementKey}-back`]
    : [`${requirementKey}-photo`]
}
const getCombinedDocumentRequirements = (documents, customTemplates = []) => [...new Set(
  documents.flatMap((document) => getDocumentRequirements(document, customTemplates))
)]
const getRequirementPhotoStorageKey = (document, photoKey, documents) => (
  documents.length > 1 ? photoKey : getDocumentPhotoKey(document, photoKey)
)
const getAvailableRequirementPhoto = (photos, document, photoKey, documents) => (
  photos?.[getRequirementPhotoStorageKey(document, photoKey, documents)]
  || photos?.[getDocumentPhotoKey(document, photoKey)]
  || photos?.[photoKey]
)
const mergeSharedRequirementPhotos = (photos, documents, customTemplates = []) => {
  const mergedPhotos = { ...(photos || {}) }
  if (documents.length < 2) return mergedPhotos

  getCombinedDocumentRequirements(documents, customTemplates).forEach((requirement) => {
    getRequirementPhotoKeys(requirement).forEach((photoKey) => {
      if (mergedPhotos[photoKey]) return
      const existingPhoto = documents
        .map((document) => mergedPhotos[getDocumentPhotoKey(document, photoKey)])
        .find(Boolean)
      if (existingPhoto) mergedPhotos[photoKey] = existingPhoto
    })
  })
  return mergedPhotos
}

const splitMultiDocumentRequests = (requests, customTemplates = []) => requests.flatMap((request) => {
  const requestedDocuments = Array.isArray(request.documents) ? request.documents : []
  const documentCopies = requestedDocuments.reduce((counts, document) => {
    counts.set(document, (counts.get(document) || 0) + 1)
    return counts
  }, new Map())
  const documents = [...documentCopies.keys()]
  if (!documents.length) return [request]
  if (documents.length === 1) {
    const document = documents[0]
    const savedCopyCount = Number(request.copyCounts?.[document] || request.documentCopyCounts?.[document] || request.copyCount)
    return [{
      ...request,
      documents,
      copyCount: Number.isSafeInteger(savedCopyCount) && savedCopyCount > 0
        ? savedCopyCount
        : documentCopies.get(document),
    }]
  }

  return documents.map((document, index) => {
    const documentSlug = document.replace(/\W+/g, '-').toLowerCase()
    const requirementPhotos = Object.fromEntries(Object.entries(request.requirementPhotos || {}).filter(([photoKey]) => (
      photoKey.startsWith(`${documentSlug}__`)
    )))
    for (const requirement of getDocumentRequirements(document, customTemplates)) {
      for (const photoKey of getRequirementPhotoKeys(requirement)) {
        const documentPhotoKey = getDocumentPhotoKey(document, photoKey)
        const photo = requirementPhotos[documentPhotoKey] || request.requirementPhotos?.[photoKey]
        if (photo) requirementPhotos[documentPhotoKey] = photo
      }
    }
    const documentFields = new Set(getCertificateTemplateFields(document, customTemplates)
      .flatMap((field) => [field.key, ...(field.targets || []).map((target) => target.key)]))
    const details = request.detailsByDocument?.[document] || Object.fromEntries(
      Object.entries(request.details || {}).filter(([key]) => documentFields.has(key) || ['address', 'contactNumber', 'birthDate'].includes(key)),
    )
    const requirements = (Array.isArray(request.requirements) ? request.requirements : []).filter((requirement) => (
      typeof requirement === 'string'
      && (requirement.startsWith(`${document} ·`)
        || getDocumentRequirements(document, customTemplates).some((label) => requirement.toLowerCase().includes(label.toLowerCase())))
    ))
    const savedCopyCount = Number(request.copyCounts?.[document] || request.documentCopyCounts?.[document] || request.copyCount)
    return {
      ...request,
      id: `${request.id}-${String(index + 1).padStart(2, '0')}`,
      submissionId: request.submissionId || request.id,
      documents: [document],
      details,
      detailsByDocument: { [document]: details },
      certificateData: { [document]: request.certificateData?.[document] || details },
      printedDocuments: request.printedDocuments?.[document] ? { [document]: true } : {},
      downloadedPdfs: request.downloadedPdfs?.[document] ? { [document]: true } : {},
      copyCount: Number.isSafeInteger(savedCopyCount) && savedCopyCount > 0
        ? savedCopyCount
        : documentCopies.get(document),
      requirementPhotos,
      requirements,
    }
  })
})

const getSubmittedRequestFields = (request, customTemplates = []) => {
  const details = request.details || {}
  const documents = request.documents || []
  if (request.detailsByDocument) {
    return documents.flatMap((document) => getCertificateTemplateFields(document, customTemplates)
      .filter((field) => {
        const value = getCertificateFieldValue(request.detailsByDocument[document], field)
        return value !== false && String(value ?? '').trim()
      })
      .map((field) => ({
        key: `${document}-${field.key}`,
        label: documents.length > 1 ? `${document} · ${field.label}` : field.label,
        value: getDisplayCertificateFieldValue(getCertificateFieldValue(request.detailsByDocument[document], field)),
      })))
  }
  const fieldsByKey = new Map(documents.flatMap((document) => getCertificateTemplateFields(document, customTemplates)).map((field) => [field.key, field]))
  return [...fieldsByKey.values()]
    .filter((field) => {
      const value = getCertificateFieldValue(details, field)
      return value !== false && String(value ?? '').trim()
    })
    .map((field) => ({
      key: field.key,
      label: field.label,
      value: getDisplayCertificateFieldValue(getCertificateFieldValue(details, field)),
    }))
}

const createDocumentRequestHistoryEntry = (request) => {
  const approval = (request.statusHistory || []).slice().reverse().find((entry) => entry.status === 'Approved - scheduling')
  return {
    id: `document-request-${request.id}`,
    type: 'documentRequest',
    requestId: request.id,
    date: request.releasedAt || request.printCompletedAt || approval?.changedAt || request.documentsApprovedAt || request.requestedAt || '',
    resident: request.resident,
    code: request.residentCode || '',
    action: request.releasedAt ? 'Document request released and archived' : 'Approved document request printed and archived',
    request,
  }
}

const restoreUnprintedApprovedRequests = (requests, history) => {
  const pendingHistory = history.filter((entry) => entry.type === 'documentRequest' && entry.request && !entry.request.printCompletedAt)
  const restoredIds = new Set(pendingHistory.map((entry) => entry.requestId || entry.request.id))
  const activeRequests = requests.filter((request) => !restoredIds.has(request.id))
  const restoredRequests = pendingHistory.map((entry) => entry.request)
  return {
    requests: [...restoredRequests, ...activeRequests],
    history: history.filter((entry) => !restoredIds.has(entry.requestId || entry.request?.id)),
  }
}

const getUnchangedPrintedDocuments = (request, certificateData) => Object.fromEntries(
  Object.entries(request.printedDocuments || {}).filter(([document, isPrinted]) => (
    isPrinted && JSON.stringify(request.certificateData?.[document] || {}) === JSON.stringify(certificateData[document] || {})
  )),
)

const getUnchangedDownloadedWordDocuments = (request, certificateData) => Object.fromEntries(
  Object.entries(request.downloadedWordDocuments || {}).filter(([document, isDownloaded]) => (
    isDownloaded && JSON.stringify(request.certificateData?.[document] || {}) === JSON.stringify(certificateData[document] || {})
  )),
)

const getSubmittedCertificateData = (request, document) => {
  const details = (document && request.detailsByDocument?.[document]) || request.details || {}
  return {
    ...getDefaultCertificateData(request),
    ...(document ? request.certificateData?.[document] || {} : {}),
    ...details,
    fullName: details.fullName || request.resident || '',
    address: document === 'Barangay Clearance'
      ? normalizeBarangayZone(details.address)
      : details.address || '',
    appearanceAddress: details.appearanceAddress || details.address || '',
    issuePurpose: details.issuePurpose || details.purpose || '',
  }
}

const getCertificateCorrectionKey = (document, field) => (
  `certificate-field:${document.replace(/\W+/g, '-').toLowerCase()}:${field.key}`
)

const getCertificateCorrectionFields = (request, customTemplates = []) => (
  (request.documents || []).flatMap((document) => {
    const data = getSubmittedCertificateData(request, document)
    return getCertificateTemplateFields(document, customTemplates)
      .map((field) => ({
        document,
        field,
        correctionKey: getCertificateCorrectionKey(document, field),
        value: getCertificateFieldValue(data, field) ?? '',
        missing: !hasCertificateFieldValue(data, field),
      }))
  })
)

const certificateTemplateSourceBlobCache = new WeakMap()
const certificateTemplateContentCache = new WeakMap()
const certificatePreviewDomCache = new WeakMap()

const getCertificateTemplateSourceBlob = (document, customTemplates = EMPTY_CERTIFICATE_TEMPLATES) => {
  const cacheKey = Array.isArray(customTemplates) ? customTemplates : EMPTY_CERTIFICATE_TEMPLATES
  let documentCache = certificateTemplateSourceBlobCache.get(cacheKey)
  if (!documentCache) {
    documentCache = new Map()
    certificateTemplateSourceBlobCache.set(cacheKey, documentCache)
  }
  if (!documentCache.has(document)) {
    const source = createFilledCertificateDocx(document, {}, cacheKey)
    documentCache.set(document, source)
    source.catch(() => {
      if (documentCache.get(document) === source) documentCache.delete(document)
    })
  }
  return documentCache.get(document)
}

const getCertificateTemplateContent = (blob) => {
  let content = certificateTemplateContentCache.get(blob)
  if (!content) {
    content = readCertificateTemplateForEditing(blob)
    certificateTemplateContentCache.set(blob, content)
    content.catch(() => {
      if (certificateTemplateContentCache.get(blob) === content) certificateTemplateContentCache.delete(blob)
    })
  }
  return content
}

const getCertificateHeaderPositions = (images) => images
  .filter((image) => image.partPath.includes('/header') && image.isFloating)
  .map((image) => ({
    description: image.altText,
    horizontal: { offset: image.x, relativeFrom: image.horizontalRelativeFrom },
    vertical: { offset: image.y, relativeFrom: image.verticalRelativeFrom },
    isWatermark: /BB1 LOGO WATERMARK/i.test(image.altText),
    isGreenLogo: /BB1 LOGO/i.test(image.altText) && !/WATERMARK/i.test(image.altText),
  }))

const waitForCertificatePreviewAssets = async (container) => {
  const images = Array.from(container?.querySelectorAll('img') || [])
  await Promise.all([
    window.document.fonts?.ready,
    ...images.map((image) => image.decode()),
  ])
}

const wrapLongCertificateUnderlines = (container) => {
  if (!container) return
  const textNodes = []
  const walker = window.document.createTreeWalker(container, window.NodeFilter.SHOW_TEXT)
  let textNode = walker.nextNode()
  while (textNode) {
    if (/_{2,}/.test(textNode.nodeValue || '')) textNodes.push(textNode)
    textNode = walker.nextNode()
  }
  textNodes.forEach((node) => {
    const text = node.nodeValue || ''
    const fragment = window.document.createDocumentFragment()
    let cursor = 0
    Array.from(text.matchAll(/_{2,}/g)).forEach((match) => {
      if (match.index > cursor) fragment.appendChild(window.document.createTextNode(text.slice(cursor, match.index)))
      const underline = window.document.createElement('span')
      underline.className = 'certificate-fillable-underline'
      underline.textContent = match[0]
      fragment.appendChild(underline)
      cursor = match.index + match[0].length
    })
    if (cursor < text.length) fragment.appendChild(window.document.createTextNode(text.slice(cursor)))
    node.parentNode?.replaceChild(fragment, node)
  })
}

const positionCertificateWatermark = (page, image) => {
  const anchor = image.parentElement
  if (!anchor) throw new Error('The certificate watermark is missing its positioning element.')
  page.style.position = 'relative'
  anchor.style.position = 'absolute'
  anchor.style.display = 'block'
  anchor.style.left = '50%'
  anchor.style.top = '50%'
  anchor.style.width = '62%'
  anchor.style.height = 'auto'
  anchor.style.margin = '0'
  anchor.style.transform = 'translate(-50%, -50%)'
  anchor.style.opacity = '0.18'
  anchor.style.zIndex = '0'
  anchor.setAttribute('aria-hidden', 'true')
  anchor.classList.add('certificate-watermark-anchor')
  image.style.display = 'block'
  image.style.width = '100%'
  image.style.height = 'auto'
  image.style.maxWidth = 'none'
  image.classList.add('certificate-watermark')
  page.querySelectorAll('header, article, footer').forEach((content) => {
    content.style.position = 'relative'
    content.style.zIndex = '1'
  })
  page.appendChild(anchor)
}

const positionCertificateHeaderLogos = (page, positions) => {
  const header = page.querySelector('header')
  const images = Array.from(header?.querySelectorAll('img') || [])
  if (!header) return
  header.style.position = 'relative'
  header.style.width = '100%'
  Array.from(header.querySelectorAll('p'))
    .filter((paragraph) => (paragraph.textContent || '').trim())
    .forEach((paragraph) => {
      paragraph.style.textAlign = 'center'
      paragraph.style.paddingLeft = '100px'
      paragraph.style.paddingRight = '100px'
      paragraph.style.boxSizing = 'border-box'
      paragraph.style.whiteSpace = 'nowrap'
    })
  if (images.length !== positions.length || !positions.length) return
  const pagePaddingLeft = Number.parseFloat(window.getComputedStyle(page).paddingLeft) || 0
  const pagePaddingTop = Number.parseFloat(window.getComputedStyle(page).paddingTop) || 0
  const logoPositions = positions.filter((position) => !position.isWatermark)
  const taggedRightLogo = logoPositions.find((position) => position.isGreenLogo)
  const rightLogoPosition = taggedRightLogo || (logoPositions.length === 2
    ? logoPositions.reduce((right, position) => position.horizontal.offset > right.horizontal.offset ? position : right)
    : null)
  const leftLogoPosition = logoPositions.find((position) => position !== rightLogoPosition)
  const redLeft = leftLogoPosition
    ? leftLogoPosition.horizontal.offset - (leftLogoPosition.horizontal.relativeFrom === 'page' ? pagePaddingLeft : 0)
    : 0

  images.forEach((image, index) => {
    const position = positions[index]
    const anchor = image.parentElement
    if (!anchor) return
    if (position.isWatermark) {
      positionCertificateWatermark(page, image)
      return
    }
    const isRightLogo = position === rightLogoPosition
    anchor.style.position = 'absolute'
    anchor.style.float = 'none'
    anchor.style.left = isRightLogo
      ? `${header.clientWidth - redLeft - image.offsetWidth}px`
      : `${position.horizontal.offset - (position.horizontal.relativeFrom === 'page' ? pagePaddingLeft : 0)}px`
    anchor.style.top = `${(isRightLogo ? leftLogoPosition?.vertical.offset ?? position.vertical.offset : position.vertical.offset)
      - (position.vertical.relativeFrom === 'page' ? pagePaddingTop : 0)}px`
    image.draggable = false
  })
}

const positionLargeCertificateBodyImages = (page) => {
  const pageWidth = page.clientWidth
  const pageHeight = page.clientHeight
  if (!pageWidth || !pageHeight) return

  page.querySelectorAll('p').forEach((paragraph) => {
    if (!/_{30,}/.test(paragraph.textContent || '')) return
    paragraph.style.whiteSpace = 'normal'
    paragraph.style.overflowWrap = 'anywhere'
    paragraph.style.wordBreak = 'break-word'
  })

  Array.from(page.querySelectorAll('img')).forEach((image) => {
    const anchor = image.parentElement
    if (!anchor || anchor.classList.contains('certificate-watermark-anchor') || anchor.closest('header')) return
    const bounds = image.getBoundingClientRect()
    const isLarge = bounds.width >= pageWidth * 0.42 || bounds.height >= pageHeight * 0.28
    if (!isLarge) return
    const label = `${image.alt || ''} ${image.title || ''} ${anchor.getAttribute('title') || ''}`
    const aspectRatio = bounds.height ? bounds.width / bounds.height : 0
    const looksLikeLogo = /logo|seal|emblem|watermark/i.test(label)
      || (aspectRatio >= 0.55 && aspectRatio <= 1.8)
    if (looksLikeLogo) positionCertificateWatermark(page, image)
  })
}

const positionCertificateFloatingImages = (page, imagePlacements) => {
  const scopes = {
    'word/document.xml': page.querySelector('article'),
    header: page.querySelector('header'),
    footer: page.querySelector('footer'),
  }
  const groups = new Map()
  imagePlacements
    .filter((image) => image.isFloating && !image.partPath.includes('/header'))
    .forEach((image) => {
      const scopeName = image.partPath === 'word/document.xml'
        ? 'word/document.xml'
        : image.partPath.includes('/header') ? 'header' : 'footer'
      const key = `${scopeName}:${image.dataUrl}`
      groups.set(key, [...(groups.get(key) || []), image])
    })
  groups.forEach((placements, key) => {
    const scope = scopes[key.slice(0, key.indexOf(':'))]
    if (!scope) return
    const dataUrl = placements[0].dataUrl
    const matches = Array.from(scope.querySelectorAll('img'))
      .filter((image) => image.currentSrc === dataUrl || image.src === dataUrl)
    placements.forEach((placement, index) => {
      const image = matches[index]
      const anchor = image?.parentElement
      if (!image || !anchor) return
      page.style.position = 'relative'
      page.style.isolation = 'isolate'
      page.appendChild(anchor)
      anchor.style.position = 'absolute'
      anchor.style.display = 'block'
      anchor.style.float = 'none'
      anchor.style.left = `${placement.x}px`
      anchor.style.top = `${placement.y}px`
      anchor.style.width = `${placement.widthPx}px`
      anchor.style.height = `${placement.heightPx}px`
      anchor.style.margin = '0'
      anchor.style.transform = 'none'
      anchor.style.zIndex = placement.behindText ? '0' : '20'
      image.style.display = 'block'
      image.style.width = '100%'
      image.style.height = '100%'
      image.style.maxWidth = 'none'
      image.style.objectFit = 'fill'
      const opacity = Number(placement.opacity)
      image.style.opacity = `${Number.isFinite(opacity) ? Math.min(100, Math.max(0, opacity)) / 100 : 1}`
      if (placement.behindText) {
        page.querySelectorAll('header, article, footer').forEach((content) => {
          content.style.position = 'relative'
          content.style.zIndex = '1'
        })
      }
    })
  })
}

const decorateCertificateDocxPages = (container, documentName, imagePlacements, headerPositions) => {
  wrapLongCertificateUnderlines(container)
  const pages = Array.from(container.querySelectorAll('section.certificate-docx'))
  pages.forEach((page) => {
    positionCertificateHeaderLogos(page, headerPositions)
    positionCertificateFloatingImages(page, imagePlacements)
    positionLargeCertificateBodyImages(page)
    page.setAttribute('aria-label', `${documentName} certificate preview`)
  })
  return pages
}

const renderCertificateDocxPages = async (container, blob, documentName, providedImages = null) => {
  let renderedDocument = certificatePreviewDomCache.get(blob)
  if (!renderedDocument) {
    renderedDocument = (async () => {
      const staging = window.document.createElement('div')
      staging.style.cssText = 'position:fixed;left:-100000px;top:0;width:max-content;visibility:hidden;pointer-events:none;'
      window.document.body.appendChild(staging)
      try {
        const [{ renderAsync }, templateContent] = await Promise.all([
          import('docx-preview'),
          providedImages ? Promise.resolve({ images: providedImages }) : getCertificateTemplateContent(blob),
        ])
        const headerPositions = getCertificateHeaderPositions(templateContent.images)
        await renderAsync(blob, staging, null, {
          className: 'certificate-docx',
          inWrapper: true,
          breakPages: true,
          useBase64URL: true,
        })
        await waitForCertificatePreviewAssets(staging)
        decorateCertificateDocxPages(staging, documentName, templateContent.images, headerPositions)
        staging.remove()
        return staging
      } catch (error) {
        staging.remove()
        throw error
      }
    })()
    certificatePreviewDomCache.set(blob, renderedDocument)
    try {
      await renderedDocument
    } catch (error) {
      if (certificatePreviewDomCache.get(blob) === renderedDocument) certificatePreviewDomCache.delete(blob)
      throw error
    }
  }
  const staging = await renderedDocument
  container.replaceChildren(...Array.from(staging.childNodes, (node) => node.cloneNode(true)))
  return Array.from(container.querySelectorAll('section.certificate-docx'))
}

const preloadCertificateTemplatePreview = async (document, customTemplates = EMPTY_CERTIFICATE_TEMPLATES) => {
  const template = getCertificateTemplate(document, customTemplates)
  if (!template || (!template.file && !template.custom)) return
  const blob = await getCertificateTemplateSourceBlob(document, customTemplates)
  await renderCertificateDocxPages(window.document.createElement('div'), blob, document)
}

const matchEditedCertificateFields = (detectedFields, previousFields) => detectedFields.map((field) => {
  const previousField = previousFields.find((candidate) => (
    (candidate.type === field.type
      || (!candidate.type && field.type !== 'checkbox')
      || (field.type === 'checkbox' && candidate.options?.includes(field.choiceLabel)))
    && ((Number.isInteger(candidate.paragraph) && candidate.paragraph === field.paragraph
      && candidate.textNodeIndex === field.textNodeIndex)
      || (!Number.isInteger(candidate.paragraph)
        && ((candidate.key === field.key && candidate.label === field.label)
          || String(candidate.label || '').trim().toLowerCase() === String(field.label || '').trim().toLowerCase())))
    && (field.type !== 'checkbox' || candidate.choiceLabel === field.choiceLabel || candidate.options?.includes(field.choiceLabel))
    && (!candidate.context || candidate.context === field.context)
  ))
  if (!previousField) return { ...field, needsReview: true, labelConfidence: 'low' }
  return {
    ...field,
    label: previousField.label || field.label,
    needsReview: Boolean(field.needsReview && previousField.labelConfidence !== 'reviewed'),
    labelConfidence: previousField.labelConfidence === 'reviewed' ? 'reviewed' : field.labelConfidence,
  }
})

function CertificatePreview({ blob, document, onClose, onDownloadSavedCertificate, onPrintPdf, savedCertificateDownloadError = '', copyCount = 1, reviewOnly = false, large = false }) {
  const panelRef = useRef(null)
  const previewContainer = useRef(null)
  const scrollContainer = useRef(null)
  const [previewError, setPreviewError] = useState('')
  const [isRendered, setIsRendered] = useState(false)
  const [isPrintingPdf, setIsPrintingPdf] = useState(false)
  const [zoom, setZoom] = useState(100)
  const [isFitToPage, setIsFitToPage] = useState(true)

  const fitDocumentToPage = useCallback(() => {
    const page = previewContainer.current?.querySelector('section.certificate-docx')
    const container = scrollContainer.current
    if (!page || !container || !container.clientWidth || !container.clientHeight) return
    const fitScale = window.matchMedia('(max-width: 720px)').matches
      ? Math.min(1, (container.clientWidth - 20) / page.offsetWidth)
      : Math.min(
        2,
        (container.clientWidth - 40) / page.offsetWidth,
        (container.clientHeight - 36) / page.offsetHeight,
      )
    setZoom(Math.max(25, Math.floor(fitScale * 100)))
  }, [])

  useEffect(() => {
    let isCurrent = true
    const renderPreview = async () => {
      setIsRendered(false)
      setPreviewError('')
      setZoom(100)
      setIsFitToPage(true)
      if (scrollContainer.current) {
        scrollContainer.current.scrollTop = 0
        scrollContainer.current.scrollLeft = 0
      }
      try {
        await renderCertificateDocxPages(previewContainer.current, blob, document)
        if (!isCurrent) return
        previewContainer.current?.querySelectorAll('section.certificate-docx').forEach((page) => {
          page.setAttribute('aria-label', `${document} certificate preview`)
        })
        if (large) fitDocumentToPage()
        setIsRendered(true)
      } catch (error) {
        console.error(`Unable to render ${document} preview.`, error)
        if (isCurrent) setPreviewError('The document preview could not be displayed. You can try generating it again.')
      }
    }

    renderPreview()
    return () => { isCurrent = false }
  }, [blob, document, fitDocumentToPage, large])

  useEffect(() => {
    if (!large || !isRendered || !isFitToPage) return undefined
    const container = scrollContainer.current
    if (!container) return undefined
    const observer = new ResizeObserver(fitDocumentToPage)
    observer.observe(container)
    return () => observer.disconnect()
  }, [fitDocumentToPage, large, isFitToPage, isRendered])

  useEffect(() => {
    if (!large) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [large, onClose])

  useEffect(() => {
    if (!isRendered) return
    let scrollContainer = panelRef.current?.parentElement
    while (scrollContainer) {
      const { overflowY } = window.getComputedStyle(scrollContainer)
      if (['auto', 'scroll'].includes(overflowY) && scrollContainer.scrollHeight > scrollContainer.clientHeight) break
      scrollContainer = scrollContainer.parentElement
    }
    if (scrollContainer && panelRef.current) {
      const containerBounds = scrollContainer.getBoundingClientRect()
      const panelBounds = panelRef.current.getBoundingClientRect()
      scrollContainer.scrollTo({
        top: scrollContainer.scrollTop + panelBounds.top - containerBounds.top - 12,
        behavior: 'smooth',
      })
    }
  }, [document, isRendered])

  const printPreview = useCallback(async () => {
    if (!onPrintPdf || isPrintingPdf) return
    setIsPrintingPdf(true)
    setPreviewError('')
    try {
      await onPrintPdf(document)
    } catch (error) {
      console.error(`Unable to prepare the ${document} PDF for printing.`, error)
      setPreviewError(error instanceof Error ? error.message : 'The certificate PDF could not be prepared for printing.')
    } finally {
      setIsPrintingPdf(false)
    }
  }, [document, isPrintingPdf, onPrintPdf])

  const previewPanel = (
    <section className={`docx-preview-panel${large ? ' certificate-filled-preview-modal certificate-template-preview-modal' : ''}`} ref={panelRef} aria-labelledby="docx-preview-title" role={large ? 'dialog' : undefined} aria-modal={large ? 'true' : undefined}>
      <div className="docx-preview-toolbar">
        <div><p className="section-number">{reviewOnly ? 'SAVED CERTIFICATE REVIEW' : 'DOCUMENT PREVIEW'}</p><h3 id="docx-preview-title">{document}</h3></div>
        <div className="docx-preview-actions">
          {large && <div className="certificate-template-zoom" role="group" aria-label="Document zoom controls">
            <button type="button" onClick={() => { setIsFitToPage(false); setZoom((current) => Math.max(25, current - 10)) }} aria-label="Zoom out">−</button>
            <span aria-live="polite">{zoom}%</span>
            <button type="button" onClick={() => { setIsFitToPage(false); setZoom((current) => Math.min(200, current + 10)) }} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => setIsFitToPage(true)}>Fit page</button>
          </div>}
          {reviewOnly && onDownloadSavedCertificate && <button type="button" onClick={onDownloadSavedCertificate}>Download DOCX</button>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
      {!isRendered && !previewError && <p className="docx-preview-loading">Preparing the original Word document preview…</p>}
      {previewError && <p className="community-update-error" role="alert">{previewError}</p>}
      {savedCertificateDownloadError && <p className="community-update-error" role="alert">{savedCertificateDownloadError}</p>}
      <p className="docx-original-template-note">{reviewOnly ? 'This preview uses the saved certificate information and original document template.' : `Preview uses the original certificate template and confirmed information. The request includes ${copyCount} ${copyCount === 1 ? 'copy' : 'copies'}.`}</p>
      <div className="docx-preview-scroll" ref={scrollContainer} style={{ visibility: isRendered ? 'visible' : 'hidden' }}><div className="docx-preview-pages" style={large ? { zoom: zoom / 100 } : undefined} ref={previewContainer} /></div>
      {large && !reviewOnly && <footer className="docx-preview-print-footer">
        <div><strong>Print at the template’s original size</strong><span>{copyCount} {copyCount === 1 ? 'copy' : 'copies'} · Original page dimensions and margins are preserved. Choose Actual size in the print dialog.</span></div>
        <button type="button" onClick={printPreview} disabled={!isRendered || isPrintingPdf}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8V3.5h10V8M6 17H4.5a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 4.5 9h15a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H18M7 14h10v6.5H7zM17.5 11.5h.01" /></svg>
          <span>{isPrintingPdf ? 'Preparing PDF…' : 'Print certificate PDF'}</span>
        </button>
      </footer>}
    </section>
  )
  return large ? (
    <div className="certificate-template-preview-backdrop certificate-filled-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      {previewPanel}
    </div>
  ) : previewPanel
}

function RegistrationEvidencePreview({ evidence, label }) {
  const [imageOpen, setImageOpen] = useState(false)
  const fileName = typeof evidence === 'string' ? evidence : evidence?.fileName || ''
  const dataUrl = typeof evidence === 'object' && evidence ? evidence.dataUrl : ''
  const mediaType = typeof evidence === 'object' && evidence ? evidence.mediaType : ''

  useEffect(() => {
    if (!imageOpen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setImageOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [imageOpen])

  return (
    <article className="registration-evidence-card">
      <header><span>{label}</span><strong>{fileName || 'No file attached'}</strong></header>
      {dataUrl && mediaType.startsWith('image/') && <>
        <button type="button" className="registration-evidence-image-button" onClick={() => setImageOpen(true)} aria-label={`Enlarge ${label} submitted by applicant`}>
          <img src={dataUrl} alt={`${label} submitted by applicant`} />
          <span>Click to enlarge</span>
        </button>
        {imageOpen && createPortal(
          <div className="community-image-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageOpen(false) }}>
            <section className="community-image-viewer registration-evidence-viewer" role="dialog" aria-modal="true" aria-label={`${label} submitted by applicant`}>
              <div className="community-image-viewer-heading">
                <strong>{label}</strong>
                <button type="button" aria-label="Close image viewer" autoFocus onClick={() => setImageOpen(false)}>×</button>
              </div>
              <img src={dataUrl} alt={`${label} submitted by applicant`} />
              {fileName && <small>{fileName}</small>}
            </section>
          </div>,
          document.body,
        )}
      </>}
      {dataUrl && mediaType === 'application/pdf' && <iframe title={label} src={dataUrl} />}
      {fileName && !dataUrl && <p>Only the file name was saved for this older application; its contents are not available to preview.</p>}
      {!fileName && <p>This imported resident record has no registration attachment.</p>}
    </article>
  )
}

function getResidentRequestDetailEntries(request) {
  const documentNames = new Set((request.documents || []).map((document) => document.trim().toLowerCase()))
  const documentDetails = (request.documents || []).flatMap((document) => Object.entries({
    ...(request.certificateData?.[document] || {}),
    ...(request.detailsByDocument?.[document] || {}),
  }))
  const submittedDetails = { ...(request.details || {}), ...Object.fromEntries(documentDetails) }
  return Object.entries(submittedDetails).filter(([key, value]) => {
    if (!value) return false
    const normalizedKey = key.replace(/[_\s-]/g, '').toLowerCase()
    if (['document', 'documents', 'requesteddocument', 'requesteddocuments'].includes(normalizedKey)) return false
    return !documentNames.has(String(value).trim().toLowerCase())
  })
}

function SavedCertificateReview({ document, certificateData, requestId, onClose, customTemplates = [] }) {
  const [blob, setBlob] = useState(null)
  const [error, setError] = useState('')
  const [downloadError, setDownloadError] = useState('')

  useEffect(() => {
    let isCurrent = true
    const prepareSavedDocument = async () => {
      try {
        const savedBlob = await createFilledCertificateDocx(document, certificateData, customTemplates)
        if (isCurrent) setBlob(savedBlob)
      } catch (previewError) {
        console.error(`Unable to prepare the saved ${document} certificate preview.`, previewError)
        if (isCurrent) setError(`The saved ${document} certificate could not be previewed.`)
      }
    }
    prepareSavedDocument()
    return () => { isCurrent = false }
  }, [document, certificateData, customTemplates])

  const downloadSavedCertificate = async () => {
    try {
      await downloadFilledCertificateDocx(document, certificateData, requestId, customTemplates)
      setDownloadError('')
    } catch (downloadFailure) {
      console.error(`Unable to download the saved ${document} certificate.`, downloadFailure)
      setDownloadError(`The saved ${document} DOCX could not be generated. Try again or check the browser console for details.`)
    }
  }

  if (blob) return <CertificatePreview blob={blob} document={document} onClose={onClose} onDownloadSavedCertificate={downloadSavedCertificate} savedCertificateDownloadError={downloadError} reviewOnly />
  return <section className="docx-preview-panel" aria-label={`${document} saved certificate review`}>
    <div className="docx-preview-toolbar"><div><p className="section-number">SAVED CERTIFICATE REVIEW</p><h3>{document}</h3></div><button type="button" onClick={onClose}>Close</button></div>
    {error ? <p className="community-update-error" role="alert">{error}</p> : <p className="docx-preview-loading">Preparing saved certificate…</p>}
  </section>
}

function SavedCertificateDownloadButton({ document, certificateData, requestId, customTemplates = [] }) {
  const [downloadError, setDownloadError] = useState('')

  const downloadCertificate = async () => {
    try {
      await downloadFilledCertificateDocx(document, certificateData, requestId, customTemplates)
      setDownloadError('')
    } catch (error) {
      console.error(`Unable to download the saved ${document} certificate.`, error)
      setDownloadError(`The saved ${document} DOCX could not be downloaded.`)
    }
  }

  return <span className="saved-certificate-download">
    <button type="button" className="resident-table-action" onClick={downloadCertificate}>Download Word</button>
    {downloadError && <small className="community-update-error" role="alert">{downloadError}</small>}
  </span>
}

function IssuedDocumentHistoryButton({ entry, request }) {
  const [error, setError] = useState('')

  const openHistory = () => {
    let historyWindow
    try {
      historyWindow = window.open('about:blank', '_blank')
      if (!historyWindow) throw new Error('Allow pop-ups to view the issued document history.')
      const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[character])
      const formatDate = (value) => {
        const date = value ? new Date(value) : null
        return date && !Number.isNaN(date.getTime())
          ? date.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
          : 'Date not recorded'
      }
      const stringify = (value) => Array.isArray(value)
        ? value.join(', ')
        : value && typeof value === 'object'
          ? JSON.stringify(value)
          : String(value ?? 'Not provided')
      const statusHistory = request
        ? withRequestStatusHistory(request).statusHistory
        : [{ status: 'Received', changedAt: entry.date }]
      const details = request?.detailsByDocument?.[entry.document] || request?.details || {}
      const requirements = request?.requirements || []
      const activities = request?.activity || []
      const statusRows = statusHistory.map((item, index) => (
        `<li><span>${index + 1}</span><div><strong>${escape(item.status)}</strong><time>${escape(formatDate(item.changedAt))}</time></div></li>`
      )).join('')
      const detailRows = Object.entries(details).map(([label, value]) => (
        `<tr><th>${escape(label.replace(/([A-Z])/g, ' $1'))}</th><td>${escape(stringify(value))}</td></tr>`
      )).join('')
      const requirementRows = requirements.map((item) => `<li>${escape(item)}</li>`).join('')
      const activityRows = activities.map((item) => (
        `<li><strong>${escape(item.action || 'Processing update')}</strong><span>${escape(item.by || 'Staff')} · ${escape(item.time || 'Date not recorded')}</span></li>`
      )).join('')
      historyWindow.document.open()
      historyWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Process history · ${escape(entry.controlNumber)}</title><style>
        *{box-sizing:border-box}body{margin:0;padding:32px;background:#edf2ed;color:#263329;font:14px/1.5 Arial,sans-serif}.sheet{max-width:820px;margin:auto;padding:36px;background:#fff;border:1px solid #d5e0d6;border-radius:12px}.eyebrow{color:#3c7a45;font-size:11px;font-weight:700;letter-spacing:.14em}h1{margin:4px 0 20px;font-size:26px}h2{margin:24px 0 8px;font-size:16px}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;padding:9px;border-bottom:1px solid #e4ebe4}th{width:32%;color:#526357}.timeline,.activity,.requirements{display:grid;gap:8px;margin:0;padding:0;list-style:none}.timeline li,.activity li{display:flex;gap:12px;padding:9px;border:1px solid #e4ebe4;border-radius:8px}.timeline li>span{display:grid;place-items:center;flex:0 0 26px;height:26px;border-radius:50%;background:#edf7ed;color:#286334;font-weight:700}.timeline li div,.activity li{min-width:0}.timeline li time,.activity li span{display:block;color:#68746a;font-size:12px}.requirements{padding-left:22px;list-style:disc}.actions{display:flex;justify-content:flex-start;margin-bottom:20px}.actions button{display:grid;place-items:center;width:40px;height:40px;padding:8px;border:0;border-radius:50%;background:#2e7041;color:#fff;cursor:pointer}.actions button:hover{background:#245b34}.actions button:focus-visible{outline:3px solid #8ccf8d;outline-offset:3px}.actions svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}@media print{body{padding:0;background:#fff}.sheet{max-width:none;padding:0;border:0;border-radius:0}.actions{display:none}h1{font-size:22px}h2{break-after:avoid}.timeline li,.activity li,table tr{break-inside:avoid}}
      </style></head><body><main class="sheet"><div class="actions"><button id="back-history" type="button" aria-label="Back to issued documents" title="Back to issued documents"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 12H5m7 7-7-7 7-7"/></svg></button></div><p class="eyebrow">BARANGAY BAGONG BAYAN 1 · ISSUANCE REGISTER</p><h1>Issued document process history</h1><table><tbody>
      <tr><th>Control number</th><td>${escape(entry.controlNumber)}</td></tr><tr><th>Request ID</th><td>${escape(entry.requestId)}</td></tr><tr><th>Resident / recipient</th><td>${escape(entry.releasedTo || entry.resident)}</td></tr><tr><th>Document</th><td>${escape(entry.document)}</td></tr><tr><th>Purpose</th><td>${escape(entry.purpose || 'Not provided')}</td></tr><tr><th>OR number</th><td>${escape(entry.orNumber || '—')}</td></tr><tr><th>Issuing officer</th><td>${escape(entry.issuingOfficer || '—')}</td></tr><tr><th>Issued</th><td>${escape(formatDate(entry.date))}</td></tr>
      </tbody></table><h2>Request status timeline</h2><ol class="timeline">${statusRows || '<li>No status history was recorded.</li>'}</ol><h2>Submitted information</h2><table><tbody>${detailRows || '<tr><td colspan="2">No submitted information was recorded.</td></tr>'}</tbody></table><h2>Requirements</h2><ul class="requirements">${requirementRows || '<li>No requirement history was recorded.</li>'}</ul><h2>Processing activity</h2><ul class="activity">${activityRows || '<li>No processing activity was recorded.</li>'}</ul></main></body></html>`)
      historyWindow.document.close()
      historyWindow.document.getElementById('back-history')?.addEventListener('click', () => {
        historyWindow.close()
      })
      setError('')
    } catch (openError) {
      console.error('Unable to open the issued document process history.', openError)
      historyWindow?.close()
      setError(openError instanceof Error ? openError.message : 'The issued document history could not be opened.')
    }
  }

  return <span className="issued-document-history-control">
    <button type="button" className="open-request issued-document-history-action" onClick={openHistory} aria-label={`View process history for ${entry.document}`}>
      View history
    </button>
    {error && <small className="issued-document-history-error" role="alert">{error}</small>}
  </span>
}

function CertificateTemplateRequestPicker({ document, requests, viewedState, onClose, onSelect }) {
  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  return createPortal(
    <div className="certificate-template-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="certificate-template-request-picker" role="dialog" aria-modal="true" aria-labelledby="certificate-template-picker-title">
        <header>
          <div><p className="section-number">DOCUMENT PROCESSING</p><h3 id="certificate-template-picker-title">Choose a request</h3><p>Select a request that still needs {document}.</p></div>
          <button type="button" onClick={onClose} aria-label="Close request picker">×</button>
        </header>
        {requests.length ? (
          <div className="certificate-template-request-list">
            {requests.map((request) => <button type="button" className={isDocumentWorkflowUnviewed(request, viewedState) ? 'is-workflow-unviewed' : ''} key={request.id} onClick={() => onSelect(request)}>
              <span><strong>{request.resident}{request.processingRequestIds.length > 1 ? ` (${request.processingRequestIds.length})` : ''}</strong><small>{request.processingRequestIds.length > 1 ? `${request.processingRequestIds.length} matching requests · ${request.copyCount} copies · ` : ''}{request.processingRequestIds.join(', ')} · {request.requestedAt ? new Date(request.requestedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : request.date || 'Date not recorded'}</small></span>
              <span className="certificate-template-request-select">Open processing <span aria-hidden="true">→</span></span>
            </button>)}
          </div>
        ) : <p className="certificate-template-request-empty">There are no requests currently in document processing that still need this certificate.</p>}
      </section>
    </div>,
    window.document.body,
  )
}

const normalizeCertificateTitleText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()

const getCertificateDocumentTitleKey = (paragraphs, document) => {
  const normalizedDocument = normalizeCertificateTitleText(document)
  const candidates = paragraphs.filter((paragraph) => (
    paragraph.partPath === 'word/document.xml'
    && paragraph.text.trim()
    && paragraph.text.trim().length <= 120
  ))
  if (['income certification', 'solo parent certification'].includes(normalizedDocument)) {
    const translatedTitle = candidates.find((paragraph) => (
      normalizeCertificateTitleText(paragraph.text) === 'sertipikasyon'
    ))
    if (translatedTitle) return translatedTitle.key
  }

  const titleWords = normalizedDocument.split(' ').filter((word) => !['certificate', 'of', 'to'].includes(word))
  const titleParagraph = candidates.find((paragraph) => {
    const normalizedText = normalizeCertificateTitleText(paragraph.text)
    const textWords = new Set(normalizedText.split(' '))
    const isHeading = paragraph.text.trim() === paragraph.text.trim().toLocaleUpperCase()
      || paragraph.style.bold
      || Number(paragraph.style.fontSize) >= 14
    return titleWords.length > 0 && isHeading && titleWords.every((word) => textWords.has(word))
  })
  return titleParagraph?.key || candidates.find((paragraph) => (
    normalizeCertificateTitleText(paragraph.text) === normalizedDocument
  ))?.key || ''
}

function CertificateTemplateContentEditor({ document, customTemplates, onClose, onApply, uploadedFile = null }) {
  const editorCanvasRef = useRef(null)
  const paragraphsRef = useRef([])
  const imagesRef = useRef([])
  const imageElementsRef = useRef(new Map())
  const imageLayoutMeasuredRef = useRef(false)
  const [sourceBlob, setSourceBlob] = useState(null)
  const [paragraphs, setParagraphs] = useState([])
  const [images, setImages] = useState([])
  const [imageReplacements, setImageReplacements] = useState({})
  const [insertedImages, setInsertedImages] = useState([])
  const [activeInsertedImageId, setActiveInsertedImageId] = useState('')
  const [activeExistingImageId, setActiveExistingImageId] = useState('')
  const [activeParagraphKey, setActiveParagraphKey] = useState('')
  const [activePart, setActivePart] = useState('word/document.xml')
  const [pageSizeId, setPageSizeId] = useState('short')
  const [originalPageSizeId, setOriginalPageSizeId] = useState('short')
  const [pageOrientation, setPageOrientation] = useState('portrait')
  const [originalPageOrientation, setOriginalPageOrientation] = useState('portrait')
  const [originalPageDimensions, setOriginalPageDimensions] = useState({ widthTwips: 12240, heightTwips: 15840 })
  const [isLoading, setIsLoading] = useState(true)
  const [isRendered, setIsRendered] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [previewFile, setPreviewFile] = useState(null)
  const [previewedDraft, setPreviewedDraft] = useState(false)
  const [reviewFields, setReviewFields] = useState(null)
  const template = uploadedFile ? null : getCertificateTemplate(document, customTemplates)

  useEffect(() => {
    const body = window.document.body
    const previousOverflow = body.style.overflow
    const previousPaddingRight = body.style.paddingRight
    const scrollbarWidth = window.innerWidth - window.document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`
    return () => {
      body.style.overflow = previousOverflow
      body.style.paddingRight = previousPaddingRight
    }
  }, [])

  useEffect(() => {
    paragraphsRef.current = paragraphs
  }, [paragraphs])

  useEffect(() => {
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    imageElementsRef.current = new Map()
    imageLayoutMeasuredRef.current = false
  }, [sourceBlob])

  useEffect(() => {
    let isCurrent = true
    const loadTemplate = async () => {
      try {
        if (!uploadedFile && !template) throw new Error(`The ${document} template is not available.`)
        const source = uploadedFile || await getCertificateTemplateSourceBlob(document, customTemplates)
        const content = await getCertificateTemplateContent(source)
        if (!isCurrent) return
        const titleKey = getCertificateDocumentTitleKey(content.paragraphs, document)
        const editorParagraphs = content.paragraphs.map((paragraph) => (
          (paragraph.partPath.includes('/header') && paragraph.text.trim()) || paragraph.key === titleKey
            ? { ...paragraph, style: { ...paragraph.style, alignment: 'center' } }
            : paragraph
        ))
        paragraphsRef.current = editorParagraphs
        imagesRef.current = content.images
        setSourceBlob(source)
        setParagraphs(editorParagraphs)
        setImages(content.images)
        setActiveParagraphKey(editorParagraphs[0]?.key || '')
        setActivePart('word/document.xml')
        setPageSizeId(content.pageSize.id)
        setOriginalPageSizeId(content.pageSize.id)
        setPageOrientation(content.pageSize.id === 'a4' ? 'portrait' : content.pageSize.orientation)
        setOriginalPageOrientation(content.pageSize.orientation)
        setOriginalPageDimensions(content.pageSize)
      } catch (loadError) {
        console.error(`Unable to open the ${document} template editor.`, loadError)
        if (isCurrent) setError(loadError.message || 'The certificate template could not be opened.')
      } finally {
        if (isCurrent) setIsLoading(false)
      }
    }
    loadTemplate()
    return () => { isCurrent = false }
  }, [document, customTemplates, template, uploadedFile])

  useEffect(() => {
    if (!sourceBlob || !editorCanvasRef.current) return undefined
    let isCurrent = true
    const renderEditableTemplate = async () => {
      setIsRendered(false)
      try {
        const pageSizeChanged = pageSizeId !== originalPageSizeId || pageOrientation !== originalPageOrientation
        const renderBlob = pageSizeChanged
          ? await updateCertificateTemplateDocx(sourceBlob, {
            pageSize: { id: pageSizeId, orientation: pageOrientation },
          })
          : sourceBlob
        await renderCertificateDocxPages(editorCanvasRef.current, renderBlob, document, imagesRef.current)
        if (!isCurrent) return
        const pageSize = CERTIFICATE_EDITOR_PAGE_SIZES[pageSizeId]
        const pageWidthTwips = pageSizeChanged
          ? pageOrientation === 'landscape' ? pageSize.heightTwips : pageSize.widthTwips
          : pageOrientation === 'landscape' ? originalPageDimensions.heightTwips : originalPageDimensions.widthTwips
        const pageHeightTwips = pageSizeChanged
          ? pageOrientation === 'landscape' ? pageSize.widthTwips : pageSize.heightTwips
          : pageOrientation === 'landscape' ? originalPageDimensions.widthTwips : originalPageDimensions.heightTwips
        editorCanvasRef.current.querySelectorAll('section.certificate-docx').forEach((page) => {
          page.style.boxSizing = 'border-box'
          page.style.width = `${pageWidthTwips / 15}px`
          page.style.height = `${pageHeightTwips / 15}px`
          page.style.minHeight = `${pageHeightTwips / 15}px`
        })
        const renderedImages = Array.from(editorCanvasRef.current.querySelectorAll('img'))
        const sameSourceGroups = new Map()
        imagesRef.current.forEach((image) => {
          const group = sameSourceGroups.get(image.dataUrl) || []
          group.push({ image })
          sameSourceGroups.set(image.dataUrl, group)
        })
        const imageElements = new Map()
        const measuredImages = new Map()
        sameSourceGroups.forEach((placements, dataUrl) => {
          const matches = renderedImages.filter((element) => element.currentSrc === dataUrl || element.src === dataUrl)
          placements.forEach(({ image }, placementOffset) => {
            const instances = matches.filter((_, matchIndex) => matchIndex % placements.length === placementOffset)
            const usableInstances = instances.length ? instances : matches.slice(placementOffset, placementOffset + 1)
            imageElements.set(image.placementId, usableInstances)
            const firstImage = usableInstances[0]
            const page = firstImage?.closest('section.certificate-docx')
            if (!firstImage || !page) return
            const imageBounds = firstImage.getBoundingClientRect()
            const pageBounds = page.getBoundingClientRect()
            const scale = pageBounds.width && page.offsetWidth ? page.offsetWidth / pageBounds.width : 1
            measuredImages.set(image.placementId, {
              x: Math.round((imageBounds.left - pageBounds.left) * scale),
              y: Math.round((imageBounds.top - pageBounds.top) * scale),
              widthPx: Math.max(12, Math.round(imageBounds.width * scale)),
              heightPx: Math.max(12, Math.round(imageBounds.height * scale)),
            })
          })
        })
        imageElementsRef.current = imageElements
        if (measuredImages.size && !imageLayoutMeasuredRef.current) {
          setImages((current) => current.map((image) => {
            const layout = measuredImages.get(image.placementId)
            return layout ? { ...image, ...layout, originalLayout: { ...layout }, layoutEdited: false } : image
          }))
          imageLayoutMeasuredRef.current = true
        }
        const candidates = paragraphsRef.current
        const claimed = new Set()
        const renderedParagraphs = Array.from(editorCanvasRef.current.querySelectorAll('section.certificate-docx p'))
        const normalizeText = (value) => String(value || '').replace(/\s+/g, ' ').trim()
        renderedParagraphs.forEach((element) => {
          const scope = element.closest('header, footer, article')
          const scopedCandidates = scope?.matches('header')
            ? candidates.filter((candidate) => candidate.partPath.includes('/header'))
            : scope?.matches('footer')
              ? candidates.filter((candidate) => candidate.partPath.includes('/footer'))
              : scope?.matches('article')
                ? candidates.filter((candidate) => candidate.partPath === 'word/document.xml')
                : candidates
          const renderedText = normalizeText(element.textContent)
          let paragraph = scopedCandidates.find((candidate) => (
            !claimed.has(candidate.key) && normalizeText(candidate.originalText) === renderedText
          ))
          if (!paragraph && renderedText) {
            paragraph = scopedCandidates.find((candidate) => (
              !claimed.has(candidate.key)
              && normalizeText(candidate.originalText)
              && (normalizeText(candidate.originalText).includes(renderedText)
                || renderedText.includes(normalizeText(candidate.originalText)))
            ))
          }
          if (!paragraph) return
          claimed.add(paragraph.key)
          if (paragraph.text !== paragraph.originalText) element.innerText = paragraph.text
          element.dataset.certificateParagraphKey = paragraph.key
          element.dataset.certificatePartPath = paragraph.partPath
          element.contentEditable = 'false'
          element.setAttribute('role', 'textbox')
          element.setAttribute('aria-label', `Edit ${paragraph.partLabel} paragraph`)
          element.setAttribute('aria-multiline', 'true')
          element.addEventListener('focus', () => {
            setActiveParagraphKey(paragraph.key)
            setActivePart(paragraph.partPath)
          })
          element.addEventListener('input', () => {
            const text = element.innerText.replace(/\u00a0/g, ' ')
            setParagraphs((current) => current.map((item) => (
              item.key === paragraph.key ? { ...item, text } : item
            )))
            setPreviewedDraft(false)
            setReviewFields(null)
          })
        })
        editorCanvasRef.current.querySelectorAll('section.certificate-docx').forEach((page) => {
          page.setAttribute('contenteditable', 'false')
        })
        if (isCurrent) setIsRendered(true)
      } catch (renderError) {
        console.error(`Unable to render the ${document} template editor canvas.`, renderError)
        if (isCurrent) setError(renderError.message || 'The certificate page could not be displayed for editing.')
      }
    }
    renderEditableTemplate()
    return () => { isCurrent = false }
  }, [document, originalPageDimensions, originalPageOrientation, originalPageSizeId, pageOrientation, pageSizeId, sourceBlob])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        if (previewFile) setPreviewFile(null)
        else onClose()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose, previewFile])

  const updateParagraph = (key, update) => {
    setParagraphs((current) => current.map((paragraph) => (
      paragraph.key === key ? { ...paragraph, ...update } : paragraph
    )))
    setActiveParagraphKey(key)
    setPreviewedDraft(false)
    setReviewFields(null)
  }

  const addTextMarker = (marker) => {
    const activeElement = editorCanvasRef.current?.querySelector(`[data-certificate-paragraph-key="${activeParagraphKey}"]`)
    if (!activeElement) {
      setError('Select a paragraph on the page before inserting a blank or checkbox.')
      return
    }
    if (activeParagraph?.partPath !== 'word/document.xml') {
      setError('Resident fillable fields can only be inserted in the document body. Header and footer text can still be edited.')
      return
    }
    activeElement.focus()
    const selection = window.getSelection()
    const hasSelection = selection?.rangeCount && activeElement.contains(selection.getRangeAt(0).commonAncestorContainer)
    if (hasSelection) {
      window.document.execCommand('insertText', false, marker)
    } else {
      activeElement.appendChild(activeElement.ownerDocument.createTextNode(marker))
    }
    activeElement.dispatchEvent(new Event('input', { bubbles: true }))
    setError('')
  }

  const replaceImage = async (image, file) => {
    if (!file) return
    if (file.type !== image.mimeType) {
      setError(`Choose a ${image.mimeType.split('/')[1].toUpperCase()} image to match the original ${image.path.split('/').pop()} file.`)
      return
    }
    if (file.size > 1500000) {
      setError('Replacement pictures must be 1.5 MB or smaller.')
      return
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('The picture could not be read.'))
        reader.readAsDataURL(file)
      })
      setImageReplacements((current) => ({
        ...current,
        [image.path]: { dataUrl, contentBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) },
      }))
      setError('')
    } catch (readError) {
      console.error(`Unable to read a replacement picture for ${document}.`, readError)
      setError(readError.message || 'The replacement picture could not be read.')
    }
  }

  const saveEdits = async () => {
    if (!sourceBlob) return
    setError('')
    setIsSaving(true)
    try {
      const changedParagraphs = paragraphs
        .filter((paragraph) => {
          return (
            paragraph.text !== paragraph.originalText
            || Object.keys(paragraph.style).some((key) => paragraph.style[key] !== paragraph.originalStyle?.[key])
          )
        })
        .map((paragraph) => ({
          partPath: paragraph.partPath,
          paragraphIndex: paragraph.paragraphIndex,
          text: paragraph.text,
          ...(paragraph.style.alignment !== paragraph.originalStyle?.alignment ? { alignment: paragraph.style.alignment } : {}),
          ...(paragraph.style.fontName !== paragraph.originalStyle?.fontName && paragraph.style.fontName ? { fontName: paragraph.style.fontName } : {}),
          ...(paragraph.style.fontSize !== paragraph.originalStyle?.fontSize && paragraph.style.fontSize ? { fontSize: paragraph.style.fontSize } : {}),
          ...(paragraph.style.color !== paragraph.originalStyle?.color && paragraph.style.color ? { color: paragraph.style.color } : {}),
          ...(paragraph.style.bold !== paragraph.originalStyle?.bold ? { bold: paragraph.style.bold } : {}),
          ...(paragraph.style.italic !== paragraph.originalStyle?.italic ? { italic: paragraph.style.italic } : {}),
          ...(paragraph.style.underline !== paragraph.originalStyle?.underline ? { underline: paragraph.style.underline } : {}),
        }))
      const imageFiles = [...new Map(images
        .filter((image) => imageReplacements[image.path])
        .map((image) => [image.path, { path: image.path, mimeType: image.mimeType, ...imageReplacements[image.path] }])).values()]
      const imageLayouts = images.filter((image) => image.layoutEdited).map((image) => ({
        partPath: image.partPath,
        drawingIndex: image.drawingIndex,
        x: image.x,
        y: image.y,
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        opacity: image.opacity,
        crop: image.crop,
        wrapMode: image.wrapMode,
        behindText: image.behindText,
      }))
      const pageSizeChanged = pageSizeId !== originalPageSizeId || pageOrientation !== originalPageOrientation
      if (!changedParagraphs.length && !imageFiles.length && !imageLayouts.length && !insertedImages.length && !pageSizeChanged) {
        setError('Make a text, formatting, picture, or paper-size change before applying the edited template.')
        return
      }
      const blob = await updateCertificateTemplateDocx(sourceBlob, {
        paragraphs: changedParagraphs,
        imageFiles,
        imageLayouts,
        insertedImages,
        ...(pageSizeChanged ? { pageSize: { id: pageSizeId, orientation: pageOrientation } } : {}),
      })
      const file = new File([blob], template?.originalFilename || uploadedFile?.name || `${document}.docx`, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      if (!reviewFields) {
        const fields = await onApply(file)
        if (!Array.isArray(fields)) throw new Error('The edited template fields could not be reviewed.')
        setReviewFields(fields)
        setError('')
        return
      }
      if (reviewFields.some((field) => field.needsReview || !field.label.trim())) {
        setError('Review and give a clear label to every field marked “Needs review” before saving.')
        return
      }
      const applied = await onApply(file, reviewFields)
      if (applied === false) return
      onClose()
    } catch (saveError) {
      console.error(`Unable to apply edits to the ${document} template.`, saveError)
      setError(saveError.message || 'The edited template could not be prepared.')
    } finally {
      setIsSaving(false)
    }
  }

  const draftPreview = async () => {
    if (!sourceBlob) return
    setError('')
    setIsSaving(true)
    try {
      const changedParagraphs = paragraphs
        .filter((paragraph) => paragraph.text !== paragraph.originalText
          || Object.keys(paragraph.style).some((key) => paragraph.style[key] !== paragraph.originalStyle?.[key]))
        .map((paragraph) => ({
          partPath: paragraph.partPath,
          paragraphIndex: paragraph.paragraphIndex,
          text: paragraph.text,
          ...(paragraph.style.alignment !== paragraph.originalStyle?.alignment ? { alignment: paragraph.style.alignment } : {}),
          ...(paragraph.style.fontName !== paragraph.originalStyle?.fontName && paragraph.style.fontName ? { fontName: paragraph.style.fontName } : {}),
          ...(paragraph.style.fontSize !== paragraph.originalStyle?.fontSize && paragraph.style.fontSize ? { fontSize: paragraph.style.fontSize } : {}),
          ...(paragraph.style.color !== paragraph.originalStyle?.color && paragraph.style.color ? { color: paragraph.style.color } : {}),
          ...(paragraph.style.bold !== paragraph.originalStyle?.bold ? { bold: paragraph.style.bold } : {}),
          ...(paragraph.style.italic !== paragraph.originalStyle?.italic ? { italic: paragraph.style.italic } : {}),
          ...(paragraph.style.underline !== paragraph.originalStyle?.underline ? { underline: paragraph.style.underline } : {}),
        }))
      const imageFiles = [...new Map(images
        .filter((image) => imageReplacements[image.path])
        .map((image) => [image.path, { path: image.path, mimeType: image.mimeType, ...imageReplacements[image.path] }])).values()]
      const imageLayouts = images.filter((image) => image.layoutEdited).map((image) => ({
        partPath: image.partPath,
        drawingIndex: image.drawingIndex,
        x: image.x,
        y: image.y,
        widthPx: image.widthPx,
        heightPx: image.heightPx,
        opacity: image.opacity,
        crop: image.crop,
        wrapMode: image.wrapMode,
        behindText: image.behindText,
      }))
      const pageSizeChanged = pageSizeId !== originalPageSizeId || pageOrientation !== originalPageOrientation
      const blob = await updateCertificateTemplateDocx(sourceBlob, {
        paragraphs: changedParagraphs,
        imageFiles,
        imageLayouts,
        insertedImages,
        ...(pageSizeChanged ? { pageSize: { id: pageSizeId, orientation: pageOrientation } } : {}),
      })
      setPreviewFile(new File([blob], template?.originalFilename || uploadedFile?.name || `${document}.docx`, {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }))
      setPreviewedDraft(true)
      setReviewFields(null)
    } catch (previewError) {
      console.error(`Unable to preview edits to the ${document} template.`, previewError)
      setError(previewError.message || 'The edited template preview could not be prepared.')
    } finally {
      setIsSaving(false)
    }
  }

  const activeParagraph = paragraphs.find((paragraph) => paragraph.key === activeParagraphKey)
  const canFormatActiveParagraph = Boolean(activeParagraph && activeParagraph.partPath === activePart)
  const partOptions = [...new Map(paragraphs.map((paragraph) => [paragraph.partPath, paragraph.partLabel])).entries()]

  const addPicture = async (file) => {
    if (!file) return
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      setError('Add a PNG or JPEG picture.')
      return
    }
    if (file.size > 1500000) {
      setError('Pictures must be 1.5 MB or smaller.')
      return
    }
    if (!activeParagraph) {
      setError('Select a paragraph on the page before adding a picture.')
      return
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('The picture could not be read.'))
        reader.readAsDataURL(file)
      })
      const id = `editor-image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      setInsertedImages((current) => [...current, {
        id,
        paragraphKey: activeParagraph.key,
        partPath: activeParagraph.partPath,
        paragraphIndex: activeParagraph.paragraphIndex,
        mimeType: file.type,
        contentBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        dataUrl,
        altText: file.name.replace(/\.[^.]+$/, ''),
        x: 80,
        y: 80,
        widthPx: 160,
        heightPx: 120,
        opacity: 100,
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
        behindText: false,
        wrapMode: 'none',
      }])
      setActiveInsertedImageId(id)
      setPreviewedDraft(false)
      setReviewFields(null)
      setError('')
    } catch (readError) {
      console.error(`Unable to read a new picture for ${document}.`, readError)
      setError(readError.message || 'The picture could not be read.')
    }
  }

  const updateInsertedImage = (index, update) => {
    setInsertedImages((current) => current.map((image, imageIndex) => (
      imageIndex === index ? { ...image, ...update } : image
    )))
    setPreviewedDraft(false)
    setReviewFields(null)
  }

  const updateExistingImage = (index, update) => {
    setImages((current) => current.map((image, imageIndex) => (
      imageIndex === index ? { ...image, ...update, layoutEdited: true } : image
    )))
    setPreviewedDraft(false)
    setReviewFields(null)
  }

  const activeExistingImageIndex = images.findIndex((image) => image.placementId === activeExistingImageId)
  const activeInsertedImageIndex = insertedImages.findIndex((image) => image.id === activeInsertedImageId)
  const activePicture = activeExistingImageIndex >= 0
    ? { ...images[activeExistingImageIndex], editorType: 'existing' }
    : activeInsertedImageIndex >= 0
      ? { ...insertedImages[activeInsertedImageIndex], editorType: 'inserted' }
      : null
  const activePictureCrop = activePicture?.crop || { left: 0, top: 0, right: 0, bottom: 0 }
  const changeActivePart = (partPath) => {
    setActivePart(partPath)
    setActiveExistingImageId('')
    setActiveInsertedImageId('')
    const target = paragraphs.find((paragraph) => paragraph.partPath === partPath)
    if (target) setActiveParagraphKey(target.key)
  }
  const selectPicture = (picture) => {
    if (picture.partPath !== activePart) {
      setActivePart(picture.partPath)
      const target = paragraphs.find((paragraph) => (
        paragraph.partPath === picture.partPath && paragraph.paragraphIndex === picture.paragraphIndex
      )) || paragraphs.find((paragraph) => paragraph.partPath === picture.partPath)
      if (target) setActiveParagraphKey(target.key)
    }
    if (picture.editorType === 'existing') {
      setActiveExistingImageId(picture.placementId)
      setActiveInsertedImageId('')
    } else {
      setActiveInsertedImageId(picture.id)
      setActiveExistingImageId('')
    }
  }
  const selectablePictures = [
    ...images.map((image) => ({
      ...image,
      editorType: 'existing',
      selected: activeExistingImageId === image.placementId,
      previewDataUrl: imageReplacements[image.path]?.dataUrl || image.dataUrl,
    })),
    ...insertedImages.map((image) => ({
      ...image,
      editorType: 'inserted',
      selected: activeInsertedImageId === image.id,
      previewDataUrl: image.dataUrl,
    })),
  ]
  const updateSelectedPicture = (update) => {
    if (activeExistingImageIndex >= 0) updateExistingImage(activeExistingImageIndex, update)
    else if (activeInsertedImageIndex >= 0) updateInsertedImage(activeInsertedImageIndex, update)
  }

  useEffect(() => {
    paragraphs.forEach((paragraph) => {
      const element = editorCanvasRef.current?.querySelector(`[data-certificate-paragraph-key="${paragraph.key}"]`)
      if (!element) return
      const style = paragraph.style || {}
      const isActiveSection = paragraph.partPath === activePart
      element.contentEditable = String(isActiveSection)
      element.setAttribute('aria-readonly', String(!isActiveSection))
      element.tabIndex = isActiveSection ? 0 : -1
      element.style.fontFamily = style.fontName || ''
      element.style.fontSize = style.fontSize ? `${style.fontSize}pt` : ''
      element.style.color = style.color || ''
      element.style.textAlign = style.alignment === 'both' ? 'justify' : style.alignment || ''
      element.style.fontWeight = style.bold ? 'bold' : ''
      element.style.fontStyle = style.italic ? 'italic' : ''
      element.style.textDecoration = style.underline ? 'underline' : ''
      element.classList.toggle('is-editor-selected', paragraph.key === activeParagraphKey)
      element.classList.toggle('is-editor-locked', !isActiveSection)
    })
  }, [activePart, activeParagraphKey, isRendered, paragraphs])

  useEffect(() => {
    const container = editorCanvasRef.current
    if (!isRendered || !container) return
    const activeIds = new Set(insertedImages
      .filter((image) => image.partPath === activePart)
      .map((image) => `inserted/${image.id}`))
    images.forEach((image) => {
      if (image.partPath !== activePart) return
      (imageElementsRef.current.get(image.placementId) || []).forEach((_, instanceIndex) => {
        activeIds.add(`existing/${image.placementId}/${instanceIndex}`)
      })
    })
    Array.from(container.querySelectorAll('.certificate-editor-image-overlay')).forEach((overlay) => {
      if (!activeIds.has(overlay.dataset.imageId)) overlay.remove()
    })
    const getOverlay = (id, page, altText, dataUrl, opacity = 100, crop = {}) => {
      let overlay = Array.from(container.querySelectorAll('.certificate-editor-image-overlay'))
        .find((candidate) => candidate.dataset.imageId === id)
      if (!overlay) {
        overlay = window.document.createElement('div')
        overlay.className = 'certificate-editor-image-overlay'
        overlay.dataset.imageId = id
        overlay.setAttribute('role', 'button')
        overlay.tabIndex = 0
        const viewport = window.document.createElement('span')
        viewport.className = 'certificate-editor-image-viewport'
        const picture = window.document.createElement('img')
        viewport.appendChild(picture)
        const resizeHandle = window.document.createElement('button')
        resizeHandle.type = 'button'
        resizeHandle.className = 'certificate-editor-image-resize'
        overlay.append(viewport, resizeHandle)
      }
      if (overlay.parentElement !== page) page.appendChild(overlay)
      const picture = overlay.querySelector('img')
      picture.src = dataUrl
      picture.alt = altText || ''
      const opacityValue = Number(opacity)
      picture.style.opacity = `${Number.isFinite(opacityValue) ? Math.min(100, Math.max(0, opacityValue)) / 100 : 1}`
      const cropLeft = Math.max(0, Number(crop.left) || 0)
      const cropTop = Math.max(0, Number(crop.top) || 0)
      const cropRight = Math.max(0, Number(crop.right) || 0)
      const cropBottom = Math.max(0, Number(crop.bottom) || 0)
      const visibleWidth = Math.max(10000, 100000 - cropLeft - cropRight)
      const visibleHeight = Math.max(10000, 100000 - cropTop - cropBottom)
      picture.style.left = `${-(cropLeft / visibleWidth) * 100}%`
      picture.style.top = `${-(cropTop / visibleHeight) * 100}%`
      picture.style.width = `${100000 / visibleWidth * 100}%`
      picture.style.height = `${100000 / visibleHeight * 100}%`
      overlay.setAttribute('aria-label', `Select or move ${altText || 'picture'}`)
      overlay.querySelector('.certificate-editor-image-resize')
        .setAttribute('aria-label', `Resize ${altText || 'picture'}`)
      return overlay
    }
    images.forEach((image, index) => {
      const instances = imageElementsRef.current.get(image.placementId) || []
      instances.forEach((sourceImage, instanceIndex) => {
        const page = sourceImage.closest('section.certificate-docx')
        if (!page) return
        if (image.partPath !== activePart) {
          sourceImage.style.visibility = ''
          if (!image.isFloating && sourceImage.parentElement) sourceImage.parentElement.style.display = ''
          return
        }
        page.style.position = 'relative'
        sourceImage.style.visibility = 'hidden'
        if (!image.isFloating && sourceImage.parentElement) sourceImage.parentElement.style.display = 'none'
        const id = `existing/${image.placementId}/${instanceIndex}`
        const overlay = getOverlay(
          id,
          page,
          image.altText || image.path.split('/').pop(),
          imageReplacements[image.path]?.dataUrl || image.dataUrl,
          image.opacity,
          image.crop,
        )
        overlay.style.left = `${image.x}px`
        overlay.style.top = `${image.y}px`
        overlay.style.width = `${image.widthPx}px`
        overlay.style.height = `${image.heightPx}px`
        overlay.style.zIndex = image.behindText ? '0' : '20'
        overlay.style.pointerEvents = image.partPath === activePart ? 'auto' : 'none'
        overlay.classList.toggle('is-selected', activeExistingImageId === image.placementId)
        overlay.setAttribute('aria-pressed', String(activeExistingImageId === image.placementId))
        const selectImage = () => {
          setActiveExistingImageId(image.placementId)
          setActiveInsertedImageId('')
          const currentParagraph = paragraphs.find((item) => item.key === activeParagraphKey)
          if (!currentParagraph || currentParagraph.partPath !== image.partPath) {
            const paragraph = paragraphs.find((item) => item.partPath === image.partPath && item.paragraphIndex === image.paragraphIndex)
            if (paragraph) setActiveParagraphKey(paragraph.key)
          }
        }
        overlay.onkeydown = (event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            selectImage()
          }
        }
        overlay.onpointerdown = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          event.stopPropagation()
          selectImage()
          const resize = event.target === overlay.querySelector('.certificate-editor-image-resize')
          const pageBounds = page.getBoundingClientRect()
          const scale = pageBounds.width && page.offsetWidth ? page.offsetWidth / pageBounds.width : 1
          const startX = event.clientX
          const startY = event.clientY
          const initial = { x: image.x, y: image.y, widthPx: image.widthPx, heightPx: image.heightPx }
          let next = { ...initial }
          const moveImage = (moveEvent) => {
            const deltaX = (moveEvent.clientX - startX) * scale
            const deltaY = (moveEvent.clientY - startY) * scale
            next = resize
              ? {
                ...initial,
                widthPx: Math.max(12, Math.min(2000, Math.round(initial.widthPx + deltaX))),
                heightPx: Math.max(12, Math.min(2000, Math.round(initial.heightPx + deltaY))),
              }
              : {
                ...initial,
                x: Math.max(-4000, Math.min(4000, Math.round(initial.x + deltaX))),
                y: Math.max(-4000, Math.min(4000, Math.round(initial.y + deltaY))),
              }
            overlay.style.left = `${next.x}px`
            overlay.style.top = `${next.y}px`
            overlay.style.width = `${next.widthPx}px`
            overlay.style.height = `${next.heightPx}px`
          }
          const finishMove = () => {
            window.removeEventListener('pointermove', moveImage)
            window.removeEventListener('pointerup', finishMove)
            window.removeEventListener('pointercancel', finishMove)
            if (next.x !== initial.x || next.y !== initial.y
              || next.widthPx !== initial.widthPx || next.heightPx !== initial.heightPx) {
              updateExistingImage(index, next)
            }
          }
          window.addEventListener('pointermove', moveImage)
          window.addEventListener('pointerup', finishMove, { once: true })
          window.addEventListener('pointercancel', finishMove, { once: true })
        }
      })
    })
    insertedImages.forEach((image, index) => {
      const paragraphElement = container.querySelector(`[data-certificate-paragraph-key="${image.paragraphKey}"]`)
      const page = paragraphElement?.closest('section.certificate-docx')
      if (!page) return
      page.style.position = 'relative'
      const overlay = getOverlay(`inserted/${image.id}`, page, image.altText, image.dataUrl, image.opacity, image.crop)
      overlay.style.left = `${image.x}px`
      overlay.style.top = `${image.y}px`
      overlay.style.width = `${image.widthPx}px`
      overlay.style.height = `${image.heightPx}px`
      overlay.style.zIndex = image.behindText ? '0' : '20'
      overlay.style.pointerEvents = image.partPath === activePart ? 'auto' : 'none'
      overlay.classList.toggle('is-selected', activeInsertedImageId === image.id)
      overlay.setAttribute('aria-pressed', String(activeInsertedImageId === image.id))
      overlay.onpointerdown = (event) => {
        if (event.button !== 0) return
        event.preventDefault()
        event.stopPropagation()
        setActiveInsertedImageId(image.id)
        setActiveExistingImageId('')
        const resize = event.target === overlay.querySelector('.certificate-editor-image-resize')
        const pageBounds = page.getBoundingClientRect()
        const scale = pageBounds.width && page.offsetWidth ? page.offsetWidth / pageBounds.width : 1
        const startX = event.clientX
        const startY = event.clientY
        const initial = { x: image.x, y: image.y, widthPx: image.widthPx, heightPx: image.heightPx }
        let next = { ...initial }
        const moveImage = (moveEvent) => {
          const deltaX = (moveEvent.clientX - startX) * scale
          const deltaY = (moveEvent.clientY - startY) * scale
          next = resize
            ? {
              ...initial,
              widthPx: Math.max(12, Math.min(2000, Math.round(initial.widthPx + deltaX))),
              heightPx: Math.max(12, Math.min(2000, Math.round(initial.heightPx + deltaY))),
            }
            : {
              ...initial,
              x: Math.max(-4000, Math.min(4000, Math.round(initial.x + deltaX))),
              y: Math.max(-4000, Math.min(4000, Math.round(initial.y + deltaY))),
            }
          overlay.style.left = `${next.x}px`
          overlay.style.top = `${next.y}px`
          overlay.style.width = `${next.widthPx}px`
          overlay.style.height = `${next.heightPx}px`
        }
        const finishMove = () => {
          window.removeEventListener('pointermove', moveImage)
          window.removeEventListener('pointerup', finishMove)
          window.removeEventListener('pointercancel', finishMove)
          updateInsertedImage(index, next)
        }
        window.addEventListener('pointermove', moveImage)
        window.addEventListener('pointerup', finishMove, { once: true })
        window.addEventListener('pointercancel', finishMove, { once: true })
      }
    })
  }, [activeExistingImageId, activeInsertedImageId, activeParagraphKey, activePart, imageReplacements, images, insertedImages, isRendered, paragraphs])

  return createPortal(
    <div className="certificate-template-preview-backdrop certificate-template-editor-backdrop">
      <section className="docx-preview-panel certificate-template-content-editor" role="dialog" aria-modal="true" aria-labelledby="certificate-content-editor-title">
        <header className="certificate-content-editor-heading">
          <div className="certificate-editor-heading-copy"><p className="section-number">TEMPLATE LAYOUT EDITOR</p><h2 id="certificate-content-editor-title">{document}</h2><p>Only the selected document section can be edited. The header stays fixed while you work on the body.</p></div>
          <button type="button" className="certificate-editor-close" onClick={onClose}>Close editor</button>
        </header>
        {error && <p className="community-update-error" role="alert">{error}</p>}
        {!isLoading && paragraphs.length === 0
          ? <p className="docx-preview-loading">No editable Word paragraphs were found in this template.</p>
            : <div className="certificate-template-editor-workspace">
              <aside className="certificate-template-editor-tools" aria-label="Page editing tools">
                <section className="certificate-editor-tool-section">
                  <h3>Document section</h3>
                  <select value={activePart} disabled={isLoading} onChange={(event) => {
                    changeActivePart(event.target.value)
                    const target = paragraphs.find((paragraph) => paragraph.partPath === event.target.value)
                    if (target) editorCanvasRef.current?.querySelector(`[data-certificate-paragraph-key="${target.key}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
                  }}>{partOptions.map(([partPath, partLabel]) => <option key={partPath} value={partPath}>{partLabel}</option>)}</select>
                  <label className="certificate-editor-page-size">Paper size
                    <select value={pageSizeId} disabled={isLoading} onChange={(event) => {
                      const nextPageSizeId = event.target.value
                      setPageSizeId(nextPageSizeId)
                      if (nextPageSizeId === 'a4') setPageOrientation('portrait')
                      setPreviewedDraft(false)
                      setReviewFields(null)
                    }}>
                      {Object.entries(CERTIFICATE_EDITOR_PAGE_SIZES).map(([id, size]) => <option key={id} value={id}>{size.label}</option>)}
                    </select>
                  </label>
                </section>
                {activeParagraph && <section className={`certificate-editor-tool-section${canFormatActiveParagraph ? '' : ' is-locked'}`}>
                  <h3>Selected paragraph</h3>
                  {!canFormatActiveParagraph && <small>Select this paragraph's section to change its formatting.</small>}
                  <div className="certificate-editor-paragraph-toolbar" role="toolbar" aria-label="Selected paragraph formatting">
                    <button type="button" aria-pressed={activeParagraph.style.bold} aria-label="Bold" title="Bold" disabled={!canFormatActiveParagraph} onClick={() => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, bold: !activeParagraph.style.bold } })}><strong>B</strong></button>
                    <button type="button" aria-pressed={activeParagraph.style.italic} aria-label="Italic" title="Italic" disabled={!canFormatActiveParagraph} onClick={() => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, italic: !activeParagraph.style.italic } })}><em>I</em></button>
                    <button type="button" aria-pressed={activeParagraph.style.underline} aria-label="Underline" title="Underline" disabled={!canFormatActiveParagraph} onClick={() => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, underline: !activeParagraph.style.underline } })}><u>U</u></button>
                    <label>Align<select aria-label="Paragraph alignment" value={activeParagraph.style.alignment} disabled={!canFormatActiveParagraph} onChange={(event) => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, alignment: event.target.value } })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option><option value="both">Justified</option></select></label>
                  </div>
                  <div className="certificate-content-formatting">
                    <label>Font<select value={activeParagraph.style.fontName} disabled={!canFormatActiveParagraph} onChange={(event) => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, fontName: event.target.value } })}><option value="">Keep template</option>{['Arial', 'Calibri', 'Times New Roman', 'Georgia', 'Verdana', 'Tahoma'].map((font) => <option key={font}>{font}</option>)}</select></label>
                    <label>Size<select value={activeParagraph.style.fontSize} disabled={!canFormatActiveParagraph} onChange={(event) => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, fontSize: event.target.value } })}><option value="">Keep size</option>{[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72].map((size) => <option key={size} value={size}>{size} pt</option>)}</select></label>
                    <label>Text color<input aria-label="Selected paragraph text color" type="color" value={activeParagraph.style.color || '#000000'} disabled={!canFormatActiveParagraph} onChange={(event) => updateParagraph(activeParagraph.key, { style: { ...activeParagraph.style, color: event.target.value } })} /></label>
                  </div>
                  <div className="certificate-editor-insert-actions">
                    <button type="button" disabled={!canFormatActiveParagraph} onClick={() => addTextMarker(' ____________________ ')}>Insert fillable blank</button>
                    <button type="button" disabled={!canFormatActiveParagraph} onClick={() => addTextMarker(' ☐ Option ')}>Insert checkbox choice</button>
                  </div>
                </section>}
                <section className="certificate-editor-tool-section">
                  <h3>Pictures · {images.length + insertedImages.length}</h3>
                  <label className="certificate-editor-picture-upload">Add picture<input type="file" accept="image/png,image/jpeg" onChange={(event) => { addPicture(event.target.files?.[0]); event.target.value = '' }} /></label>
                  <small>Choose a picture here or select it on the page. Drag to move it; use its corner handle to resize.</small>
                  <div className="certificate-editor-picture-picker" role="group" aria-label="Select picture">
                    <strong>Select picture</strong>
                    {selectablePictures.length
                      ? <div className="certificate-editor-picture-picker-list">{selectablePictures.map((picture) => (
                        <button type="button" key={picture.editorType === 'existing' ? picture.placementId : picture.id} className={picture.selected ? 'is-selected' : ''} aria-pressed={picture.selected} aria-label={`Select ${picture.altText || 'picture'}`} onClick={() => selectPicture(picture)}>
                          <img src={picture.previewDataUrl} alt={picture.altText || 'Document picture'} />
                        </button>
                      ))}</div>
                      : <p className="certificate-editor-no-fields">This document has no pictures yet.</p>}
                  </div>
                  {activePicture
                    ? <div className="certificate-editor-inserted-image is-selected">
                      <label>Left (px)<input type="number" min="-4000" max="4000" value={Math.round(activePicture.x)} onChange={(event) => updateSelectedPicture({ x: Number(event.target.value) })} /></label>
                      <label>Top (px)<input type="number" min="-4000" max="4000" value={Math.round(activePicture.y)} onChange={(event) => updateSelectedPicture({ y: Number(event.target.value) })} /></label>
                      <label>Width (px)<input type="number" min="12" max="2000" value={Math.round(activePicture.widthPx)} onChange={(event) => updateSelectedPicture({ widthPx: Number(event.target.value) })} /></label>
                      <label>Height (px)<input type="number" min="12" max="2000" value={Math.round(activePicture.heightPx)} onChange={(event) => updateSelectedPicture({ heightPx: Number(event.target.value) })} /></label>
                      {['left', 'top', 'right', 'bottom'].map((side) => {
                        const oppositeSide = side === 'left' ? 'right' : side === 'right' ? 'left' : side === 'top' ? 'bottom' : 'top'
                        const value = Math.round(activePictureCrop[side] / 1000)
                        const max = Math.max(0, Math.min(90, 99 - Math.round(activePictureCrop[oppositeSide] / 1000)))
                        return <label className="certificate-editor-crop-control" key={side}>
                          Crop {side} <output>{value}%</output>
                          <input type="range" min="0" max={max} step="1" value={Math.min(max, value)} onChange={(event) => updateSelectedPicture({
                            crop: { ...activePictureCrop, [side]: Number(event.target.value) * 1000 },
                          })} />
                        </label>
                      })}
                      <label className="certificate-editor-opacity">Opacity <output>{activePicture.opacity ?? 100}%</output>
                        <input type="range" min="0" max="100" step="1" value={activePicture.opacity ?? 100} onChange={(event) => updateSelectedPicture({ opacity: Number(event.target.value) })} />
                      </label>
                      <label className="certificate-editor-picture-layout">Layer
                        <select value={activePicture.behindText ? 'back' : 'front'} onChange={(event) => updateSelectedPicture({ behindText: event.target.value === 'back' })}>
                          <option value="front">Move to front</option>
                          <option value="back">Send to back</option>
                        </select>
                      </label>
                      <label className="certificate-editor-picture-layout">Text wrap
                        <select value={activePicture.wrapMode} onChange={(event) => updateSelectedPicture({ wrapMode: event.target.value })}>
                          <option value="none">No wrap · overlap</option>
                          <option value="square">Square</option>
                          <option value="topBottom">Top and bottom</option>
                        </select>
                      </label>
                      {activePicture.editorType === 'existing'
                        ? <label className="certificate-editor-picture-upload">Replace picture<input type="file" accept={activePicture.mimeType} onChange={(event) => { replaceImage(activePicture, event.target.files?.[0]); event.target.value = '' }} /></label>
                        : <button type="button" className="table-delete" onClick={() => {
                          setInsertedImages((current) => current.filter((image) => image.id !== activePicture.id))
                          setActiveInsertedImageId('')
                          setPreviewedDraft(false)
                          setReviewFields(null)
                        }}>Remove picture</button>}
                    </div>
                    : <p className="certificate-editor-no-fields">No picture is selected. Select one on the page to edit its position, size, opacity, or layer.</p>}
                </section>
              </aside>
              <main className="certificate-template-editor-paper-area">
                <div className="certificate-template-editor-canvas" ref={editorCanvasRef} aria-label="Editable certificate page" aria-busy={!isRendered} />
              </main>
            </div>}
        {reviewFields && <section className="certificate-editor-field-review" aria-label="Review detected resident fields">
          <div><h3>Review resident fields</h3><p>Fields removed from the page are removed here. New or uncertain fields need a clear label. Existing proof-document requirements are unchanged.</p></div>
          {reviewFields.length
            ? <div className="certificate-editor-field-list">{reviewFields.map((field, index) => <label key={`${field.key}-${field.paragraph}-${field.textNodeIndex}-${index}`} className={field.needsReview ? 'needs-review' : ''}>
              <span><strong>{field.type === 'checkbox' ? `Checkbox: ${field.choiceLabel || 'Choice'}` : `Field ${index + 1}`}</strong><small>{field.context || `Paragraph ${Number(field.paragraph) + 1}`}</small></span>
              <input value={field.label} aria-label={`Field ${index + 1} resident-facing label`} onChange={(event) => {
                const label = event.target.value
                const normalizedLabel = label.trim().toLowerCase()
                const needsReview = !normalizedLabel || ['please identify this field', 'select an option'].includes(normalizedLabel)
                setReviewFields((current) => current.map((item, itemIndex) => itemIndex === index
                  ? { ...item, label, needsReview, labelConfidence: needsReview ? 'low' : 'reviewed' }
                  : item))
              }} />
              {field.needsReview && <em>Needs review</em>}
            </label>)}</div>
            : <p className="certificate-editor-no-fields">No fillable resident fields remain. The document can still be saved as a template.</p>}
        </section>}
        <footer className="certificate-content-editor-actions">
          <span>{paragraphs.length} paragraphs · {images.length + insertedImages.length} pictures · {reviewFields ? `${reviewFields.length} resident fields detected` : 'Template content and margins retained'}{!previewedDraft ? ' · Preview again after each change' : ''}</span>
          <button type="button" className="resident-table-action" disabled={!isRendered || isSaving || !sourceBlob} onClick={draftPreview}>Preview edits</button>
          <button type="button" className="check-button" disabled={!isRendered || isSaving || !sourceBlob || !previewedDraft} onClick={saveEdits}>{isSaving ? 'Preparing…' : reviewFields ? uploadedFile ? 'Apply edits' : 'Save template' : 'Review fields'}</button>
        </footer>
        {previewFile && <CertificateTemplatePreview document={document} uploadedFile={previewFile} aboveEditor onClose={() => setPreviewFile(null)} />}
      </section>
    </div>,
    window.document.body,
  )
}

function CertificateTemplatePreview({ document, onClose, customTemplates = EMPTY_CERTIFICATE_TEMPLATES, uploadedFile = null, aboveEditor = false }) {
  const previewRef = useRef(null)
  const scrollRef = useRef(null)
  const pageSizeRef = useRef(null)
  const [previewError, setPreviewError] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [previewAttempt, setPreviewAttempt] = useState(0)
  const [zoom, setZoom] = useState(100)
  const [isFitToPage, setIsFitToPage] = useState(true)

  const fitDocumentToPage = useCallback(() => {
    const page = previewRef.current?.querySelector('section.certificate-docx')
    const container = scrollRef.current
    if (!page || !container) return
    const pageWidth = pageSizeRef.current?.width || page.offsetWidth
    const pageHeight = pageSizeRef.current?.height || page.offsetHeight
    if (!pageWidth || !pageHeight || !container.clientWidth || !container.clientHeight) return
    pageSizeRef.current = { width: pageWidth, height: pageHeight }
    const fitScale = window.matchMedia('(max-width: 720px)').matches
      ? Math.min(1, (container.clientWidth - 20) / pageWidth)
      : Math.min(
        1,
        (container.clientWidth - 40) / pageWidth,
        (container.clientHeight - 36) / pageHeight,
      )
    setZoom(Math.max(25, Math.floor(fitScale * 100)))
  }, [])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    let isCurrent = true
    const renderTemplate = async () => {
      setIsLoading(true)
      setPreviewError('')
      setZoom(100)
      setIsFitToPage(true)
      try {
        previewRef.current?.replaceChildren()
        pageSizeRef.current = null
        const template = uploadedFile ? null : getCertificateTemplate(document, customTemplates)
        if (!uploadedFile && (!template || (!template.file && !template.custom))) {
          throw new Error(`No template file is mapped for ${document}.`)
        }
        const blob = uploadedFile || await getCertificateTemplateSourceBlob(document, customTemplates)
        await renderCertificateDocxPages(previewRef.current, blob, document)
        if (!isCurrent) return
        previewRef.current?.querySelectorAll('section.certificate-docx').forEach((page) => {
          page.setAttribute('contenteditable', 'false')
          const fixedHeader = page.querySelector('header')
          if (fixedHeader) {
            fixedHeader.setAttribute('contenteditable', 'false')
            fixedHeader.setAttribute('aria-readonly', 'true')
          }
        })
        if (isCurrent) {
          fitDocumentToPage()
          setIsLoading(false)
        }
      } catch (error) {
        console.error(`Unable to preview the ${document} template.`, error)
        if (isCurrent) {
          const reason = error instanceof Error ? error.message : String(error)
          setPreviewError(`The ${document} DOCX template preview could not be loaded. ${reason}`)
          setIsLoading(false)
        }
      }
    }
    renderTemplate()
    return () => { isCurrent = false }
  }, [customTemplates, document, fitDocumentToPage, previewAttempt, uploadedFile])

  useEffect(() => {
    if (isLoading || !isFitToPage) return undefined
    const container = scrollRef.current
    if (!container) return undefined
    const observer = new ResizeObserver(fitDocumentToPage)
    observer.observe(container)
    return () => observer.disconnect()
  }, [fitDocumentToPage, isFitToPage, isLoading])

  return createPortal(
    <div className={`certificate-template-preview-backdrop${aboveEditor ? ' certificate-template-draft-preview-backdrop' : ''}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="docx-preview-panel certificate-template-preview-modal" role="dialog" aria-modal="true" aria-label={`${document} template preview`}>
        <div className="docx-preview-toolbar">
          <div><p className="section-number">CERTIFICATE TEMPLATE</p><h3>{document}</h3></div>
          <div className="certificate-template-preview-controls">
            <div className="certificate-template-zoom" role="group" aria-label="Document zoom controls">
              <button type="button" onClick={() => { setIsFitToPage(false); setZoom((current) => Math.max(25, current - 10)) }} aria-label="Zoom out">−</button>
              <span aria-live="polite">{zoom}%</span>
              <button type="button" onClick={() => { setIsFitToPage(false); setZoom((current) => Math.min(200, current + 10)) }} aria-label="Zoom in">+</button>
              <button type="button" onClick={() => setIsFitToPage(true)}>Fit page</button>
            </div>
            <button type="button" onClick={onClose} autoFocus aria-label="Close template preview">Close preview</button>
          </div>
        </div>
        {previewError && <div className="certificate-template-preview-error"><p className="community-update-error" role="alert">{previewError}</p><button type="button" className="resident-table-action" onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>Retry preview</button></div>}
        <div className="docx-preview-scroll" ref={scrollRef}>
          <div className="docx-preview-pages certificate-template-preview-pages" style={{ zoom: zoom / 100 }} ref={previewRef} />
        </div>
      </section>
    </div>,
    window.document.body,
  )
}

function ResidentDocumentGuide({ documents, onClose, onAcknowledge, customTemplates = [] }) {
  const guideScrollRef = useRef(null)
  const [hasViewedGuide, setHasViewedGuide] = useState(false)
  const [templateHeader, setTemplateHeader] = useState(null)
  const [templateHeaderError, setTemplateHeaderError] = useState('')
  const guideDocument = documents[0]
  const currentTemplateHeader = templateHeader?.document === guideDocument ? templateHeader.artwork : null
  const currentTemplateHeaderError = templateHeaderError?.document === guideDocument ? templateHeaderError.message : ''

  useEffect(() => {
    let isCurrent = true
    const loadTemplateHeader = async () => {
      try {
        const template = getCertificateTemplate(guideDocument, customTemplates)
        if (template?.custom) {
          if (isCurrent) setTemplateHeader({ document: guideDocument, artwork: { images: [], lines: [] } })
          return
        }
        if (!template?.file) throw new Error(`No certificate template is mapped for ${guideDocument}.`)
        const response = await fetch(template.file)
        if (!response.ok) throw new Error(`The ${guideDocument} template could not be loaded.`)
        const artwork = await getCertificateTemplateHeaderArtwork(await response.blob())
        if (artwork.images.length < 2 || artwork.lines.length < 4) {
          throw new Error(`The ${guideDocument} template is missing its complete letterhead.`)
        }
        if (isCurrent) setTemplateHeader({ document: guideDocument, artwork })
      } catch (error) {
        console.error('Unable to load the original certificate-template letterhead for the resident guide.', error)
        if (isCurrent) setTemplateHeaderError({ document: guideDocument, message: 'The original template letterhead could not be loaded. Close this guide and try again.' })
      }
    }
    loadTemplateHeader()
    return () => { isCurrent = false }
  }, [customTemplates, guideDocument])

  useEffect(() => {
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  useEffect(() => {
    const scrollContainer = guideScrollRef.current
    if (!scrollContainer) return undefined

    const updateViewedState = () => {
      const isAtBottom = scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 4
      if (isAtBottom) setHasViewedGuide(true)
    }

    const resizeObserver = new ResizeObserver(updateViewedState)
    resizeObserver.observe(scrollContainer)
    scrollContainer.addEventListener('scroll', updateViewedState)
    updateViewedState()
    return () => {
      resizeObserver.disconnect()
      scrollContainer.removeEventListener('scroll', updateViewedState)
    }
  }, [documents])

  return createPortal(
    <div className="resident-document-guide-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <section className="resident-document-guide-window" role="dialog" aria-modal="true" aria-labelledby="resident-document-guide-title">
        <header className="resident-document-guide-toolbar">
          <div><span className="section-number">BEFORE YOU APPLY</span><strong>Document request guide</strong></div>
          <button type="button" onClick={onClose} aria-label="Close document guide">×</button>
        </header>
        <div className="resident-document-guide-scroll" ref={guideScrollRef}>
          <article className="resident-document-guide-paper">
            <header className="resident-document-guide-letterhead">
              {currentTemplateHeader?.images.map((image, index) => <img
                className={image.isGreenLogo ? 'is-green-logo' : 'is-seal-logo'}
                src={image.src}
                alt={image.isGreenLogo ? 'Barangay Bagong Bayan 1 logo' : 'Barangay seal'}
                key={`${image.isGreenLogo ? 'green' : 'seal'}-${index}`}
              />)}
              <div>{currentTemplateHeader?.lines.map((line) => <span
                key={line.text}
                style={{ fontFamily: line.fontFamily ? `'${line.fontFamily}', serif` : undefined, fontSize: `${line.fontSizePt}pt`, fontWeight: line.isBold ? 700 : 400 }}
              >{line.text}</span>)}</div>
            </header>
            {currentTemplateHeaderError && <p className="resident-document-guide-error" role="alert">{currentTemplateHeaderError}</p>}
            <p className="resident-document-guide-kicker">RESIDENT SERVICES · APPLICATION INFORMATION</p>
            <h2 id="resident-document-guide-title">Request preparation guide</h2>
            <p className="resident-document-guide-notice">This information sheet is a guide only. It is not the certificate, an application form, or a preview of the official document.</p>
            {documents.map((document) => {
              const requirements = getDocumentRequirements(document, customTemplates)
              const fields = getCertificateTemplateFields(document, customTemplates)
              return <section className="resident-document-guide-item" key={document}>
                <h3>{document}</h3>
                <div className="resident-document-guide-columns">
                  <div><h4>Prepare these requirements</h4>{requirements.length ? <ul>{requirements.map((requirement) => <li key={requirement}>{requirement}</li>)}</ul> : <p>Confirm the requirements with the barangay office.</p>}</div>
                  <div><h4>Information to fill in this document</h4>{fields.length ? <ul>{fields.map((field) => <li key={field.key}>{field.label}{field.options?.length ? `: ${field.options.join(', ')} (${field.multiple ? 'select all that apply' : 'choose one'})` : ''}</li>)}</ul> : <p>Personal and request details.</p>}
                    {document === 'Certificate of Appearance' && <p className="resident-document-guide-footnote">Choose only your zone. Barangay Bagong Bayan I, Bongabong, Oriental Mindoro is added automatically.</p>}
                  </div>
                </div>
              </section>
            })}
            <p className="resident-document-guide-footnote">Bring clear, current supporting documents. Additional verification may be requested by the barangay office.</p>
          </article>
        </div>
        <footer className="resident-document-guide-actions">
          <span>{hasViewedGuide ? 'You’ve reached the end of the guide.' : 'Review the complete guide to continue.'}</span>
          {hasViewedGuide && <button type="button" onClick={onAcknowledge}>I’ve reviewed this information</button>}
        </footer>
      </section>
    </div>,
    document.body,
  )
}

function ApprovedCertificateEditor({ request, certificateDownloadError, getCurrentCertificateData, saveCertificateReview, downloadApprovedCertificate, downloadApprovedCertificatePdf, printApprovedCertificatePdf, recordPrintedDocument, initialDocument, customTemplates = [] }) {
  const certificateDataByDocument = getCurrentCertificateData(request)
  const copyCount = Number.isSafeInteger(Number(request.copyCount)) && Number(request.copyCount) > 0
    ? Number(request.copyCount)
    : 1
  const [outputFormat, setOutputFormat] = useState('pdf')
  const [previewDocument, setPreviewDocument] = useState(null)
  const [previewBlob, setPreviewBlob] = useState(null)
  const [previewCertificateData, setPreviewCertificateData] = useState(null)
  const [previewError, setPreviewError] = useState('')
  const [isPreparingPreview, setIsPreparingPreview] = useState(false)
  const summaryDocument = initialDocument || request.documents[0]
  const summaryCertificateData = certificateDataByDocument[summaryDocument] || {}
  const summaryFields = getCertificateTemplate(summaryDocument, customTemplates)?.fields || []
  const printCopyCount = copyCount

  const preparePreview = async (document, certificateData = certificateDataByDocument[document]) => {
    setIsPreparingPreview(true)
    setPreviewError('')
    setPreviewBlob(null)
    setPreviewDocument(null)
    setPreviewCertificateData(null)
    try {
      saveCertificateReview(request)
      const blob = await createFilledCertificateDocx(document, certificateData, customTemplates)
      setPreviewBlob(blob)
      setPreviewDocument(document)
      setPreviewCertificateData(certificateData)
    } catch (error) {
      console.error(`Unable to prepare the ${document} preview.`, error)
      setPreviewError(`The ${document} preview could not be prepared. Try again or check the browser console for details.`)
    } finally {
      setIsPreparingPreview(false)
    }
  }

  const downloadSubmittedPdf = async (document) => {
    setIsPreparingPreview(true)
    try {
      saveCertificateReview(request)
      return await downloadApprovedCertificatePdf(request, document)
    } finally {
      setIsPreparingPreview(false)
    }
  }

  const downloadSelectedOutput = async (document) => {
    if (isPreparingPreview) return
    if (outputFormat === 'pdf') {
      await downloadSubmittedPdf(document)
      return
    }

    saveCertificateReview(request)
    setIsPreparingPreview(true)
    try {
      await downloadApprovedCertificate(request, document, certificateDataByDocument)
    } finally {
      setIsPreparingPreview(false)
    }
  }

  const markSubmittedPdfForRelease = (document) => {
    recordPrintedDocument(request, document, {
      ...certificateDataByDocument,
      [document]: getSubmittedCertificateData(request, document, customTemplates),
    })
  }

  return (
    <section className="approved-document-panel">
      {certificateDownloadError && <p className="community-update-error" role="alert">{certificateDownloadError}</p>}
      {previewError && <p className="community-update-error" role="alert">{previewError}</p>}
      <section className="certificate-processing-summary processing-confirmed-information">
        <div className="processing-confirmed-heading">
          <div><p className="detail-label">Confirmed information</p><p>{summaryDocument}</p></div>
          <span className="confirmed-information-badge"><span aria-hidden="true">✓</span> Confirmed submission</span>
        </div>
        <p className="processing-confirmed-note">Information submitted by the resident is locked during certificate preparation.</p>
        <dl className="resident-details">
          {summaryFields.filter((field) => String(summaryCertificateData[field.key] ?? '').trim()).map((field) => (
            <div key={field.key}><dt>{field.label}</dt><dd>{summaryCertificateData[field.key]}</dd></div>
          ))}
          {!summaryFields.some((field) => String(summaryCertificateData[field.key] ?? '').trim()) && <div><dt>Information</dt><dd>No confirmed information is available.</dd></div>}
          <div><dt>Copies requested</dt><dd>{copyCount}</dd></div>
        </dl>
      </section>
      <section className="certificate-output-workspace">
        <header className="certificate-output-heading">
          <div className="certificate-output-heading-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M7 3.75h7l4 4v12.5H7zM14 3.75v4h4M10 12h5M10 15h5" /></svg>
          </div>
          <div><p className="detail-label">Prepare requested documents</p><p>Select a file format or print directly from the original template.</p></div>
        </header>
        <div className="certificate-output-document-list">
          {request.documents.map((document) => {
            const template = getCertificateTemplate(document, customTemplates)
            if (!template) {
              return <p className="community-update-error" role="alert" key={document}>No DOCX template is available for “{document}”.</p>
            }
            const certificateData = certificateDataByDocument[document]
            const processingFields = getCertificateTemplateFields(document, customTemplates)
            const missingFields = processingFields.filter((field) => !hasCertificateFieldValue(certificateData, field))
            const fieldsComplete = missingFields.length === 0
            const outputLabel = outputFormat === 'pdf' ? 'Download as PDF' : 'Download Word document'

            return (
              <article className="approved-document" key={document}>
                <div className="approved-document-card-heading">
                  <span className="approved-document-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9.5 12h5M9.5 15h5" /></svg>
                  </span>
                  <div><p className="section-number">CERTIFICATE</p><h3>{document}</h3></div>
                  {request.printedDocuments?.[document]
                    ? <span className="certificate-document-status is-ready">Ready</span>
                    : <span className="certificate-document-status">In preparation</span>}
                </div>
                <div className="certificate-output-controls">
                  <label className="certificate-output-format">
                    Output format
                    <select value={outputFormat} onChange={(event) => setOutputFormat(event.target.value)} disabled={isPreparingPreview}>
                      <option value="pdf">Download as PDF</option>
                      <option value="word">Download as Word (.docx)</option>
                    </select>
                  </label>
                  <div className="certificate-copy-control">
                    <span>Copies requested</span>
                    <strong className="certificate-copy-count-display"><span>{copyCount}</span><small>{copyCount === 1 ? 'copy' : 'copies'} · fixed from request</small></strong>
                  </div>
                </div>
                <p className="certificate-output-helper">{outputFormat === 'word' ? 'Word downloads one filled template. The requested copy count remains saved with the request.' : `${copyCount} ${copyCount === 1 ? 'copy' : 'copies'} will be used for PDF and print output.`}</p>
                <div className="certificate-output-actions">
                  <button
                    type="button"
                    className="certificate-output-action"
                    disabled={!fieldsComplete || isPreparingPreview}
                    onClick={() => downloadSelectedOutput(document)}
                  >
                    {isPreparingPreview ? <span className="certificate-output-spinner" aria-hidden="true" /> : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5v11m-4-4 4 4 4-4M5 16v4h14v-4" /></svg>}
                    <span>{isPreparingPreview ? 'Preparing…' : outputLabel}</span>
                  </button>
                  <button
                    type="button"
                    className="certificate-preview-action"
                    disabled={!fieldsComplete || isPreparingPreview}
                    onClick={() => preparePreview(document, certificateData)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.3-6 9.5-6 9.5 6 9.5 6-3.3 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.5" /></svg>
                    <span>{isPreparingPreview ? 'Preparing…' : 'Preview'}</span>
                  </button>
                  {(request.downloadedPdfs?.[document] || request.downloadedWordDocuments?.[document]) && !request.printedDocuments?.[document] && (
                    <button type="button" className="certificate-mark-ready" onClick={() => markSubmittedPdfForRelease(document)}>Set ready for release</button>
                  )}
                  {request.printedDocuments?.[document] && <span className="certificate-printed-note"><span aria-hidden="true">✓</span> Marked ready for release</span>}
                  {!fieldsComplete && <small className="certificate-required-note">Complete the requested information to preview or print: {missingFields.map((field) => field.label).join(', ')}. Enter answers in English or Filipino as appropriate.</small>}
                </div>
              </article>
            )
          })}
        </div>
      </section>
      {previewBlob && previewDocument && previewCertificateData && <CertificatePreview
        key={`${request.id}-${previewDocument}`}
        blob={previewBlob}
        document={previewDocument}
        copyCount={printCopyCount}
        savedCertificateDownloadError={certificateDownloadError}
        onPrintPdf={(selectedDocument) => printApprovedCertificatePdf(request, selectedDocument)}
        onClose={() => { setPreviewBlob(null); setPreviewDocument(null); setPreviewCertificateData(null) }}
        large
      />}
    </section>
  )
}

const communityUpdatesStorageKey = 'bb1-community-updates'
const barangayContactInformationStorageKey = 'bb1-about-contact-information'
const residentRequestsStorageKey = 'bb1-resident-requests'
const residentRequestDeletionsStorageKey = 'bb1-deleted-request-ids'
const residentPaymentDraftsStorageKey = 'bb1-resident-payment-drafts'
const residentNotificationReadStateStorageKey = 'bb1-resident-notification-read-state'
const adminNavigationReadStateStorageKey = 'bb1-admin-navigation-read-state'
const gcashRecipientsStorageKey = 'bb1-gcash-recipients'
const residentRecordsStorageKey = 'bb1-resident-records'
const registrationRequestsStorageKey = 'bb1-registration-requests'
const residentCodeRecoveryRequestsStorageKey = 'bb1-resident-code-recovery-requests'
const residentProfileUpdateRequestsStorageKey = 'bb1-resident-profile-update-requests'
const documentFeesStorageKey = 'bb1-document-fees'
const adminPreferencesStorageKey = 'bb1-admin-preferences'
const documentWorkflowViewedStorageKey = 'bb1-document-workflow-viewed-v2'
const residentHistoryStorageKey = 'bb1-resident-history'
const archivedResidentsStorageKey = 'bb1-archived-residents'
const issuedDocumentsStorageKey = 'bb1-issued-documents'
const residentDraftsStorageKey = 'bb1-resident-request-drafts'
const officialAvailabilityStorageKey = 'bb1-official-availability'
const documentFeesDefaultsVersionStorageKey = 'bb1-document-fees-defaults-version'
const documentFeesDefaultsVersion = 1
const registrationCacheDatabaseName = 'bb1-registration-cache'
const registrationCacheObjectStoreName = 'records'
const registrationCacheRecordKey = 'registration-requests'
const residentLocalRecordChangeKey = 'bb1-resident-local-record-change'
const residentLocalRecordKeys = [
  residentRequestsStorageKey,
  residentPaymentDraftsStorageKey,
  residentHistoryStorageKey,
  residentDraftsStorageKey,
]

const openRegistrationCacheDatabase = () => new Promise((resolve, reject) => {
  if (!window.indexedDB) {
    reject(new Error('This browser does not support local registration storage.'))
    return
  }
  const request = window.indexedDB.open(registrationCacheDatabaseName, 1)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(registrationCacheObjectStoreName)) {
      request.result.createObjectStore(registrationCacheObjectStoreName)
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error || new Error('Unable to open local registration storage.'))
  request.onblocked = () => reject(new Error('Local registration storage is busy in another browser tab.'))
})

const loadLocalRegistrationRequests = async () => {
  const database = await openRegistrationCacheDatabase()
  try {
    const storedRequests = await new Promise((resolve, reject) => {
      const request = database
        .transaction(registrationCacheObjectStoreName, 'readonly')
        .objectStore(registrationCacheObjectStoreName)
        .get(registrationCacheRecordKey)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Unable to read local registration storage.'))
    })
    if (storedRequests === undefined) return readStoredList(registrationRequestsStorageKey, [])
    if (!Array.isArray(storedRequests) || !storedRequests.every((request) => request && typeof request.id === 'string')) {
      throw new Error('Saved local registration requests use an invalid format.')
    }
    return storedRequests
  } finally {
    database.close()
  }
}

const isLocalStorageQuotaError = (error) => (
  ['QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED'].includes(error?.name)
  || [22, 1014].includes(error?.code)
)

const saveLocalRegistrationRequests = async (requests) => {
  let indexedDbSaved = false
  let indexedDbError
  try {
    const database = await openRegistrationCacheDatabase()
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(registrationCacheObjectStoreName, 'readwrite')
        transaction.objectStore(registrationCacheObjectStoreName).put(requests, registrationCacheRecordKey)
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error || new Error('Unable to save local registration storage.'))
        transaction.onabort = () => reject(transaction.error || new Error('Local registration storage was interrupted.'))
      })
      indexedDbSaved = true
    } finally {
      database.close()
    }
  } catch (error) {
    indexedDbError = error
  }

  const browserCacheRequests = indexedDbSaved
    ? requests.map((request) => ({
      ...request,
      files: Object.fromEntries(Object.entries(request.files || {}).map(([key, evidence]) => [
        key,
        evidence && typeof evidence === 'object'
          ? Object.fromEntries(Object.entries(evidence).filter(([field]) => field !== 'dataUrl'))
          : evidence,
      ])),
    }))
    : requests

  try {
    const serializedRequests = JSON.stringify(browserCacheRequests)
    if (window.localStorage.getItem(registrationRequestsStorageKey) !== serializedRequests) {
      window.localStorage.setItem(registrationRequestsStorageKey, serializedRequests)
    }
    return { indexedDbSaved, localStorageSaved: true }
  } catch (error) {
    if (indexedDbSaved && isLocalStorageQuotaError(error)) {
      try {
        window.localStorage.removeItem(registrationRequestsStorageKey)
        window.localStorage.setItem(registrationRequestsStorageKey, JSON.stringify(browserCacheRequests))
        return { indexedDbSaved: true, localStorageSaved: true }
      } catch (cacheError) {
        if (isLocalStorageQuotaError(cacheError)) {
          return { indexedDbSaved: true, localStorageSaved: false }
        }
        throw cacheError
      }
    }
    if (!indexedDbSaved && indexedDbError && isLocalStorageQuotaError(error)) {
      throw new Error(
        `Browser storage is full, and local registration evidence could not be saved: ${indexedDbError.message}`,
        { cause: error },
      )
    }
    throw error
  }
}

const readIndexedResidentRecord = async (key) => {
  const database = await openRegistrationCacheDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database
        .transaction(registrationCacheObjectStoreName, 'readonly')
        .objectStore(registrationCacheObjectStoreName)
        .get(key)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Unable to read resident browser storage.'))
    })
  } finally {
    database.close()
  }
}

const writeIndexedResidentRecord = async (key, value) => {
  const database = await openRegistrationCacheDatabase()
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(registrationCacheObjectStoreName, 'readwrite')
      transaction.objectStore(registrationCacheObjectStoreName).put(value, key)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error || new Error('Unable to save resident browser storage.'))
      transaction.onabort = () => reject(transaction.error || new Error('Resident browser storage was interrupted.'))
    })
  } finally {
    database.close()
  }
}

const loadLocalResidentRecord = async (key, fallback) => {
  try {
    const indexedRecord = await readIndexedResidentRecord(key)
    if (indexedRecord !== undefined) {
      window.localStorage.removeItem(key)
      return indexedRecord
    }
  } catch (error) {
    console.warn(`Unable to read ${key} from IndexedDB; trying browser storage.`, error)
  }

  const serializedRecord = window.localStorage.getItem(key)
  if (serializedRecord === null) return fallback
  let parsedRecord
  try {
    parsedRecord = JSON.parse(serializedRecord)
  } catch (error) {
    console.error(`Unable to parse ${key} from browser storage.`, error)
    return fallback
  }

  try {
    await writeIndexedResidentRecord(key, parsedRecord)
    window.localStorage.removeItem(key)
  } catch (error) {
    console.warn(`Unable to migrate ${key} to IndexedDB; retaining its browser-storage copy.`, error)
  }
  return parsedRecord
}

const saveLocalResidentRecord = async (key, value) => {
  let indexedError
  try {
    await writeIndexedResidentRecord(key, value)
  } catch (error) {
    indexedError = error
  }
  if (!indexedError) {
    try {
      window.localStorage.removeItem(key)
    } catch (error) {
      console.warn(`Saved ${key} in IndexedDB but could not remove its browser-storage copy.`, error)
    }
    try {
      window.localStorage.setItem(residentLocalRecordChangeKey, JSON.stringify({
        key,
        revision: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      }))
    } catch (error) {
      console.warn(`Saved ${key} in IndexedDB but could not notify other tabs.`, error)
    }
    return
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (localStorageError) {
    throw new Error(
      `Unable to save ${key} in IndexedDB or browser storage. IndexedDB: ${indexedError.message}; browser storage: ${localStorageError.message}`,
      { cause: localStorageError },
    )
  }
}

const createResidentDraftId = () => `DRAFT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const createResidentPaymentGroupId = () => `PAY-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const isRequestReadyForDocumentProcessing = (request) => (
  request.status !== 'Cancelled'
  && (Number(request.feeAmount || 0) <= 0 || request.paymentStatus === 'Paid')
)
const isRequestSubmittedToAdmin = (request) => (
  request.status !== 'Cancelled'
  && (Number(request.feeAmount || 0) <= 0 || ['Pending verification', 'Paid'].includes(request.paymentStatus))
)
const groupPaymentRequests = (requests) => {
  const uniqueRequests = new Map()
  requests.forEach((request) => {
    const existingRequest = uniqueRequests.get(request.id)
    if (!existingRequest
      || request.paymentGroupId
      || request.paymentSubmittedAt
      || (!existingRequest.paymentGroupId && !existingRequest.paymentSubmittedAt)) {
      uniqueRequests.set(request.id, request)
    }
  })
  const groupedRequests = new Map()
  uniqueRequests.forEach((request) => {
    const proofIdentity = request.paymentProofOrNumber?.trim() || request.paymentProof?.dataUrl
    const groupId = request.paymentGroupId
      ? `batch-${request.paymentGroupId}`
      : request.paymentSubmittedAt && proofIdentity
        ? `submitted-${request.paymentSubmittedAt}-${request.paymentMethod || ''}-${proofIdentity}`
        : `single-${request.id}`
    groupedRequests.set(groupId, [...(groupedRequests.get(groupId) || []), request])
  })
  return Array.from(groupedRequests.entries()).map(([groupId, paymentRequests]) => {
    const firstRequest = paymentRequests[0]
    const paymentStatus = paymentRequests.every((request) => request.paymentStatus === 'Paid')
      ? 'Paid'
      : paymentRequests.some((request) => request.paymentStatus === 'Pending verification')
        ? 'Pending verification'
        : paymentRequests.some((request) => (request.paymentStatus || 'Unpaid') === 'Unpaid')
          ? 'Unpaid'
          : firstRequest.paymentStatus || 'Unpaid'
    return {
      ...firstRequest,
      id: firstRequest.paymentGroupId || firstRequest.id,
      requests: paymentRequests,
      requestIds: paymentRequests.map((request) => request.id),
      documents: [...new Set(paymentRequests.flatMap((request) => request.documents || []))],
      copyCount: paymentRequests.reduce((total, request) => total + (Number(request.copyCount) || 1), 0),
      feeAmount: paymentRequests.reduce((total, request) => total + Number(request.feeAmount || 0), 0),
      activeFeeAmount: paymentRequests
        .filter((request) => request.status !== 'Cancelled')
        .reduce((total, request) => total + Number(request.feeAmount || 0), 0),
      cancelledFeeAmount: paymentRequests
        .filter((request) => request.status === 'Cancelled')
        .reduce((total, request) => total + Number(request.feeAmount || 0), 0),
      cancelledRequestCount: paymentRequests.filter((request) => request.status === 'Cancelled').length,
      paymentStatus,
      awaitingPaymentSubmission: paymentRequests.every((request) => request.awaitingPaymentSubmission),
      paymentSubmittedAt: paymentRequests.find((request) => request.paymentSubmittedAt)?.paymentSubmittedAt,
      groupKey: groupId,
    }
  })
}
const initialGcashRecipients = [
  { id: 'gcash-recipient-1', displayName: 'Crizzia Mae Famenial', mobileNumber: '09531765764' },
]
const createResidentProfileUpdateId = () => `PU-${Date.now()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`
const enabledCertificateTypesStorageKey = 'bb1-enabled-certificate-types'
const officialProfilesStorageKey = 'bb1-official-profiles'
const officialPhotosStorageKey = 'bb1-official-photos'
const initialEnabledCertificateTypes = [...barangayDocuments]
const paidDocumentFeeDefaults = {
  'Barangay Clearance': 50,
  'Business Clearance': 200,
  'Certificate of Appearance': 30,
  'Certificate of Business Closure': 100,
  'Certificate of Residency': 50,
  'Income Certification': 50,
}
const initialDocumentFees = Object.fromEntries(barangayDocuments.map((document) => [document, paidDocumentFeeDefaults[document] || 0]))
const normalizeDocumentFees = (fees, documents = barangayDocuments) => Object.fromEntries(documents.map((document) => {
  const amount = Number(fees?.[document])
  return [document, Number.isFinite(amount) && amount >= 0 ? amount : 0]
}))
const migrateDocumentFees = (fees, savedVersion, documents = barangayDocuments) => {
  const normalizedFees = normalizeDocumentFees(fees, documents)
  return Number(savedVersion) >= documentFeesDefaultsVersion
    ? normalizedFees
    : { ...normalizedFees, ...paidDocumentFeeDefaults }
}
const initialCommunityUpdates = [
  { id: 'announcement-council-meeting', type: 'announcement', date: '2026-09-18', title: 'Barangay council meeting', detail: 'Conference room · 9:00 AM' },
  { id: 'announcement-report-deadline', type: 'announcement', date: '2026-09-20', title: 'Monthly report deadline', detail: 'Submit all office reports' },
  { id: 'event-cleanup-drive', type: 'event', date: '2026-09-27', title: 'Community clean-up drive', detail: 'Assembly area · 7:00 AM' },
]
const initialResidentRecords = [
  { id: 'BB1-JDC-001', name: 'Francis Harvey P. Linga', address: 'Purok 5, Barangay Bagong Bayan 1', code: 'BB1-JDC-001' },
  { id: 'BB1-MS-002', name: 'Lorelie G. Fajilan', address: 'Purok 2, Barangay Bagong Bayan 1', code: 'BB1-MS-002' },
  { id: 'BB1-PR-003', name: 'Levy James Jalos', address: 'Purok 4, Barangay Bagong Bayan 1', code: 'BB1-PR-003' },
  { id: 'BB1-JG-004', name: 'Xyrell P. Guerra', address: 'Purok 3, Barangay Bagong Bayan 1', code: 'BB1-JG-004' },
  { id: 'BB1-SD-005', name: 'Percimhe V. Masuba', address: 'Purok 1, Barangay Bagong Bayan 1', code: 'BB1-SD-005' },
]
const initialOfficialProfiles = [
  { name: 'Name to be updated', role: 'Punong Barangay', description: 'Leads barangay programs, presides over council meetings, and oversees local services.' },
  { name: 'Name to be updated', role: 'Barangay Kagawad', description: 'Supports community programs and helps address resident concerns.' },
  { name: 'Name to be updated', role: 'Barangay Kagawad', description: 'Coordinates local projects and community safety initiatives.' },
  { name: 'Name to be updated', role: 'Barangay Kagawad', description: 'Assists with public services and resident consultations.' },
  { name: 'Name to be updated', role: 'Barangay Kagawad', description: 'Helps organize community activities and local development programs.' },
  { name: 'Name to be updated', role: 'Barangay Secretary', description: 'Maintains barangay records, minutes, and resident documents.' },
  { name: 'Name to be updated', role: 'Barangay Treasurer', description: 'Records barangay finances and supports transparent fund reporting.' },
]

const readStoredList = (key, fallback) => {
  try {
    const saved = window.localStorage.getItem(key)
    if (!saved) return fallback
    const parsed = JSON.parse(saved)
    if (!Array.isArray(parsed)) throw new Error(`Saved data for ${key} must be a list.`)
    return parsed
  } catch (error) {
    console.error(`Unable to load ${key} from browser storage.`, error)
    return fallback
  }
}

const readStoredResidentNotificationReadState = () => {
  try {
    const saved = window.localStorage.getItem(residentNotificationReadStateStorageKey)
    if (!saved) return {}
    const parsed = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some((groups) => (
        !groups || typeof groups !== 'object' || Array.isArray(groups)
        || Object.values(groups).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))
      ))) {
      throw new Error('Saved resident notification read status is invalid.')
    }
    return parsed
  } catch (error) {
    console.error('Unable to load resident notification read status.', error)
    return {}
  }
}

const readStoredAdminNavigationReadState = () => {
  try {
    const saved = window.localStorage.getItem(adminNavigationReadStateStorageKey)
    if (!saved) return {}
    const parsed = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.values(parsed).some((ids) => !Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
      throw new Error('Saved admin navigation read status is invalid.')
    }
    return parsed
  } catch (error) {
    console.error('Unable to load admin navigation read status.', error)
    return {}
  }
}

const getAdminNavigationItemId = (item) => {
  const latestActivity = item.activity?.[item.activity.length - 1]?.time || ''
  const latestStatusChange = item.statusHistory?.[item.statusHistory.length - 1]?.changedAt || ''
  const updatedAt = item.updatedAt || item.reviewedAt || item.paymentSubmittedAt
    || item.cancelledAt || item.submittedAt || item.requestedAt || item.createdAt
    || latestActivity || latestStatusChange
  const content = JSON.stringify(item, (key, value) => (
    /(?:dataurl|base64|photo|image)/i.test(key) ? undefined : value
  ))
  let fingerprint = 2166136261
  for (let index = 0; index < content.length; index += 1) {
    fingerprint = Math.imul(fingerprint ^ content.charCodeAt(index), 16777619)
  }
  const identity = item.id || item.requestId || item.code || item.name || item.title || item.role || 'record'
  return `${identity}:${item.status || ''}:${updatedAt}:${(fingerprint >>> 0).toString(36)}`
}

const getResidentCommunityUpdateId = (update) => (
  `community-update-${getAdminNavigationItemId(update)}`
)

const readStoredImageMap = (key) => {
  try {
    const saved = window.localStorage.getItem(key)
    if (!saved) return {}
    const parsed = JSON.parse(saved)
    const normalized = normalizeOfficialPhotoMap(parsed)
    if (!normalized) {
      throw new Error(`Saved data for ${key} must be an image map.`)
    }
    return normalized
  } catch (error) {
    console.error(`Unable to load ${key} from browser storage.`, error)
    return {}
  }
}

const officialPhotosCacheRecordKey = 'official-photos'

const isOfficialPhotoMap = (photos) => Boolean(
  photos && typeof photos === 'object' && !Array.isArray(photos)
  && Object.values(photos).every((photo) => typeof photo === 'string'),
)

const normalizeOfficialPhotoMap = (photos) => {
  if (isOfficialPhotoMap(photos)) return photos
  if (!Array.isArray(photos) || !photos.every((photo) => photo === null || typeof photo === 'string')) return null
  return Object.fromEntries(photos.flatMap((photo, index) => (
    typeof photo === 'string' && photo ? [[String(index), photo]] : []
  )))
}

const loadLocalOfficialPhotos = async () => {
  let database
  try {
    database = await openRegistrationCacheDatabase()
  } catch (error) {
    const cachedPhotos = readStoredImageMap(officialPhotosStorageKey)
    if (Object.keys(cachedPhotos).length) return cachedPhotos
    throw error
  }
  try {
    const photos = await new Promise((resolve, reject) => {
      const request = database
        .transaction(registrationCacheObjectStoreName, 'readonly')
        .objectStore(registrationCacheObjectStoreName)
        .get(officialPhotosCacheRecordKey)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error || new Error('Unable to read saved official photos.'))
    })
    if (photos === undefined) return readStoredImageMap(officialPhotosStorageKey)
    const normalizedPhotos = normalizeOfficialPhotoMap(photos)
    if (!normalizedPhotos) throw new Error('Saved official photos use an invalid format.')
    return normalizedPhotos
  } finally {
    database.close()
  }
}

const saveLocalOfficialPhotos = async (photos) => {
  let indexedDbSaved = false
  let indexedDbError
  try {
    const database = await openRegistrationCacheDatabase()
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(registrationCacheObjectStoreName, 'readwrite')
        transaction.objectStore(registrationCacheObjectStoreName).put(photos, officialPhotosCacheRecordKey)
        transaction.oncomplete = resolve
        transaction.onerror = () => reject(transaction.error || new Error('Unable to save official photos locally.'))
        transaction.onabort = () => reject(transaction.error || new Error('Saving official photos locally was interrupted.'))
      })
      indexedDbSaved = true
    } finally {
      database.close()
    }
  } catch (error) {
    indexedDbError = error
  }

  try {
    window.localStorage.setItem(officialPhotosStorageKey, JSON.stringify(photos))
  } catch (error) {
    if (indexedDbSaved && isLocalStorageQuotaError(error)) {
      console.warn('Official photos are saved in IndexedDB because browser storage is full.')
      return
    }
    if (!indexedDbSaved && indexedDbError && isLocalStorageQuotaError(error)) {
      throw new Error(`Browser storage is full, and local photo storage is unavailable: ${indexedDbError.message}`, { cause: error })
    }
    if (indexedDbSaved) {
      console.error('Official photos are saved in IndexedDB, but the browser cache could not be updated.', error)
      return
    }
    throw error
  }
}

const normalizeBarangayContactInformation = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Saved barangay contact information must be an object.')
  }
  const fields = ['phoneNumber', 'emailAddress', 'officeAddress']
  if (fields.some((field) => typeof value[field] !== 'string')) {
    throw new Error('Saved barangay contact information has invalid fields.')
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]))
}

const initialBarangayContactInformation = { phoneNumber: '', emailAddress: '', officeAddress: '' }

const readStoredBarangayContactInformation = () => {
  try {
    const saved = window.localStorage.getItem(barangayContactInformationStorageKey)
    if (saved === null) return initialBarangayContactInformation
    return normalizeBarangayContactInformation(JSON.parse(saved))
  } catch (error) {
    console.error('Unable to load barangay contact information from browser storage.', error)
    return initialBarangayContactInformation
  }
}

const getResidentNameParts = (resident) => {
  if (resident.firstName || resident.middleName || resident.lastName || resident.suffix) {
    return {
      firstName: resident.firstName || '',
      middleName: resident.middleName || '',
      lastName: resident.lastName || '',
      suffix: resident.suffix || '',
    }
  }
  const nameParts = String(resident.name || '').trim().split(/\s+/).filter(Boolean)
  return {
    firstName: nameParts.length > 2 ? nameParts[0] : nameParts.slice(0, -1).join(' '),
    middleName: nameParts.length > 2 ? nameParts.slice(1, -1).join(' ') : '',
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : '',
    suffix: '',
  }
}

const formatResidentName = ({ firstName, middleName, lastName, suffix }) => (
  [firstName, middleName, lastName, suffix].map((part) => part.trim()).filter(Boolean).join(' ')
)

const normalizeRecoveryIdentity = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]/g, '')

const normalizeRecoveryNameParts = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .match(/[a-z0-9]+/g) || []

const recoveryNamesMatch = (submittedName, savedName) => {
  const submittedParts = normalizeRecoveryNameParts(submittedName)
  const savedParts = normalizeRecoveryNameParts(savedName)
  if (submittedParts.length < 2 || submittedParts.length > savedParts.length) return false
  let savedIndex = 0
  for (const submittedPart of submittedParts) {
    const matchedIndex = savedParts.indexOf(submittedPart, savedIndex)
    if (matchedIndex === -1) return false
    savedIndex = matchedIndex + 1
  }
  return true
}

const getClosestResidentRecord = (name, residents) => {
  const target = normalizeRecoveryIdentity(name)
  if (!target || !residents.length) return null
  const distanceBetween = (first, second) => {
    let previousRow = Array.from({ length: second.length + 1 }, (_, index) => index)
    for (let firstIndex = 1; firstIndex <= first.length; firstIndex += 1) {
      const currentRow = [firstIndex]
      for (let secondIndex = 1; secondIndex <= second.length; secondIndex += 1) {
        currentRow[secondIndex] = Math.min(
          currentRow[secondIndex - 1] + 1,
          previousRow[secondIndex] + 1,
          previousRow[secondIndex - 1] + (first[firstIndex - 1] === second[secondIndex - 1] ? 0 : 1),
        )
      }
      previousRow = currentRow
    }
    return previousRow[second.length]
  }
  return residents.reduce((closest, resident) => {
    const candidateName = normalizeRecoveryIdentity(resident.name)
    if (!candidateName) return closest
    const distance = distanceBetween(target, candidateName)
    return !closest || distance < closest.distance ? { resident, distance } : closest
  }, null)?.resident || null
}

const normalizeRecoveryDate = (value) => {
  const text = String(value || '')
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10)
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
const normalizeRecoveryEmail = (value) => String(value || '').trim().toLowerCase()
const isRecoveryEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim())

const registrationReviewInformationSections = [
  {
    key: 'personal',
    title: 'Personal information',
    fields: [
      ['firstName', 'First name'], ['middleName', 'Middle name'], ['lastName', 'Last name'], ['suffix', 'Suffix'],
      ['birthDate', 'Date of birth'], ['placeOfBirth', 'Place of birth'], ['sex', 'Sex'],
      ['civilStatus', 'Civil status'], ['nationality', 'Nationality'],
    ],
  },
  { key: 'contact', title: 'Contact information', fields: [['mobileNumber', 'Mobile number'], ['emailAddress', 'Email address']] },
  {
    key: 'address',
    title: 'Current address',
    fields: [
      ['streetPurok', 'Purok'], ['barangay', 'Barangay'],
      ['municipalityCity', 'Municipality / city'], ['province', 'Province'], ['stayDuration', 'Length of stay'],
    ],
  },
  {
    key: 'residency',
    title: 'Residency history',
    fields: [
      ['newResident', 'New resident'], ['previousAddress', 'Previous address'], ['previousBarangay', 'Previous barangay'],
      ['previousMunicipalityCity', 'Previous municipality / city'], ['dateOfTransfer', 'Date of transfer'],
      ['reasonForMoving', 'Reason for moving'],
    ],
  },
  {
    key: 'household',
    title: 'Household information',
    fields: [
      ['householdHead', 'Head of family'], ['householdHeadName', 'Household head name'],
      ['householdMembers', 'Household members'], ['relationshipToHead', 'Relationship to household head'],
    ],
  },
  {
    key: 'identification',
    title: 'Identification',
    fields: [['validIdType', 'Valid ID type'], ['idNumber', 'ID number']],
  },
  {
    key: 'proof',
    title: 'Proof of residence',
    fields: [['proofOfResidence', 'Submitted proof types']],
  },
]
const registrationReviewStepDefinitions = [
  { key: 'applicantInformation', label: 'Application information', range: '1–3', sectionKeys: ['personal', 'contact', 'address'] },
  { key: 'residencyInformation', label: 'Residency information', range: '4–6', sectionKeys: ['residency', 'household', 'identification'] },
  { key: 'photoReview', label: 'Proof of residence', range: '7', sectionKeys: ['proof'] },
]
const registrationAddressDefaults = {
  houseBlockLot: '',
  barangay: 'Bagong Bayan 1',
  municipalityCity: 'Bongabong',
  province: 'Oriental Mindoro',
}
const getRegistrationReviewSteps = () => registrationReviewStepDefinitions

const mergeRegistrationRequestLists = (primaryRequests, secondaryRequests = []) => {
  const mergedRequests = new Map()
  for (const request of [...secondaryRequests, ...primaryRequests]) {
    if (!request || typeof request.id !== 'string') continue
    const previous = mergedRequests.get(request.id)
    if (!previous) {
      mergedRequests.set(request.id, request)
      continue
    }

    const terminalStatus = ['Approved', 'Declined', 'Deleted']
    const status = terminalStatus.includes(previous.status) && request.status === 'Pending'
      ? previous.status
      : request.status
    mergedRequests.set(request.id, {
      ...previous,
      ...request,
      status,
      data: { ...(previous.data || {}), ...(request.data || {}) },
      files: { ...(previous.files || {}), ...(request.files || {}) },
      reviewSteps: { ...(request.reviewSteps || {}), ...(previous.reviewSteps || {}) },
    })
  }
  return Array.from(mergedRequests.values())
}

const getPersistedRecordTimestamp = (record) => {
  const timestamps = [
    record?.updatedAt,
    record?.reviewedAt,
    record?.paymentSubmittedAt,
    record?.submittedAt,
    record?.requestedAt,
    record?.paymentDraftedAt,
    ...(Array.isArray(record?.statusHistory)
      ? record.statusHistory.map((entry) => entry?.changedAt || entry?.createdAt || entry?.timestamp)
      : []),
  ]
  return timestamps.reduce((latest, value) => {
    const timestamp = Date.parse(value || '')
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest
  }, 0)
}

const uniqueResidentRequestsById = (requests) => {
  const requestsById = new Map()
  const requestsWithoutId = []

  requests.forEach((request) => {
    if (!request || (typeof request.id !== 'string' && typeof request.id !== 'number')) {
      requestsWithoutId.push(request)
      return
    }

    const id = String(request.id)
    const previous = requestsById.get(id)
    if (!previous || getPersistedRecordTimestamp(request) >= getPersistedRecordTimestamp(previous)) {
      requestsById.set(id, request)
    }
  })

  return [...requestsById.values(), ...requestsWithoutId]
}

const getResidentRequestSubmissionTime = (request) => Date.parse(
  request?.requestedAt
    || request?.paymentDraftedAt
    || request?.paymentSubmittedAt
    || request?.submittedAt
    || '',
) || 0

const getResidentRequestContentFingerprint = (request) => JSON.stringify([
  normalizeResidentCode(request?.residentCode || request?.resident_code),
  Array.isArray(request?.documents) ? [...request.documents].sort() : [],
  request?.copyCount ?? 1,
  request?.details || {},
  request?.requirements || [],
])

const resolveResidentRequestIdCollisions = (requests, remoteRequests) => {
  const requestsById = new Map()
  requests.forEach((request) => {
    if (!request?.id) return
    const group = requestsById.get(request.id) || []
    group.push(request)
    requestsById.set(request.id, group)
  })

  const remappedSubmissions = new Map()
  requestsById.forEach((idGroup, id) => {
    const submissions = new Map()
    idGroup.forEach((request) => {
      const submittedAt = getResidentRequestSubmissionTime(request)
      const submissionId = request.submissionId || request.id
      const key = `${submissionId}:${submittedAt}`
      const group = submissions.get(key) || []
      group.push(request)
      submissions.set(key, group)
    })

    if (submissions.size < 2) return

    const submissionGroups = [...submissions.entries()].sort(([, first], [, second]) => (
      getResidentRequestSubmissionTime(first[0]) - getResidentRequestSubmissionTime(second[0])
    ))
    const existingServerGroup = submissionGroups.find(([, group]) => remoteRequests.some((remote) => (
      remote?.id === id
      && getResidentRequestContentFingerprint(remote) === getResidentRequestContentFingerprint(group[0])
    )))
    const preservedGroupKey = existingServerGroup?.[0] || submissionGroups[0][0]

    submissionGroups.forEach(([key, group]) => {
      if (key === preservedGroupKey) return
      const submittedAt = getResidentRequestSubmissionTime(group[0])
      const originalSubmissionId = group[0].submissionId || id
      remappedSubmissions.set(key, {
        idSuffix: submittedAt || group[0].id,
        submissionId: `${originalSubmissionId}-R${submittedAt || group[0].id}`,
      })
    })
  })

  const resolvedRequests = requests.map((request) => {
    const submittedAt = getResidentRequestSubmissionTime(request)
    const submissionId = request?.submissionId || request?.id
    const remapping = remappedSubmissions.get(`${submissionId}:${submittedAt}`)
    return remapping
      ? { ...request, id: `${request.id}-R${remapping.idSuffix}`, submissionId: remapping.submissionId }
      : request
  })

  return uniqueResidentRequestsById(resolvedRequests)
}

const mergePersistedRecordLists = (databaseRecords, browserRecords, label) => {
  if (!Array.isArray(databaseRecords) || !Array.isArray(browserRecords)) {
    throw new Error(`Saved ${label} must be a list.`)
  }

  const records = new Map()
  const unkeyedRecords = []
  for (const record of databaseRecords) {
    if (record && (typeof record.id === 'string' || typeof record.id === 'number')) {
      records.set(String(record.id), record)
    } else {
      unkeyedRecords.push(record)
    }
  }

  for (const browserRecord of browserRecords) {
    if (!browserRecord || (typeof browserRecord.id !== 'string' && typeof browserRecord.id !== 'number')) {
      if (!unkeyedRecords.some((record) => JSON.stringify(record) === JSON.stringify(browserRecord))) {
        unkeyedRecords.push(browserRecord)
      }
      continue
    }

    const id = String(browserRecord.id)
    const databaseRecord = records.get(id)
    if (!databaseRecord) {
      records.set(id, browserRecord)
      continue
    }

    const browserIsNewer = getPersistedRecordTimestamp(browserRecord) > getPersistedRecordTimestamp(databaseRecord)
    const olderRecord = browserIsNewer ? databaseRecord : browserRecord
    const newerRecord = browserIsNewer ? browserRecord : databaseRecord
    records.set(id, {
      ...olderRecord,
      ...newerRecord,
      ...(olderRecord.data || newerRecord.data
        ? { data: { ...(olderRecord.data || {}), ...(newerRecord.data || {}) } }
        : {}),
      ...(olderRecord.files || newerRecord.files
        ? { files: { ...(olderRecord.files || {}), ...(newerRecord.files || {}) } }
        : {}),
      ...(olderRecord.reviewSteps || newerRecord.reviewSteps
        ? { reviewSteps: { ...(olderRecord.reviewSteps || {}), ...(newerRecord.reviewSteps || {}) } }
        : {}),
    })
  }

  return [...records.values(), ...unkeyedRecords]
}

const getResidentRecordNameKey = (resident) => normalizeRecoveryIdentity(
  resident?.name
    || resident?.fullName
    || [resident?.firstName, resident?.middleName, resident?.lastName, resident?.suffix].filter(Boolean).join(' '),
)

const deduplicateResidentRecordsByName = (residents) => {
  const seenNames = new Set()
  const uniqueResidents = []
  residents.forEach((resident) => {
    const nameKey = getResidentRecordNameKey(resident)
    if (nameKey && seenNames.has(nameKey)) return
    if (nameKey) seenNames.add(nameKey)
    uniqueResidents.push(resident)
  })
  return { residents: uniqueResidents, removedCount: residents.length - uniqueResidents.length }
}

const reconcileResidentCodeRotationRecords = (residents, recoveryRequests) => {
  const rotatedCodeByResidentId = new Map()
  recoveryRequests.forEach((request) => {
    if (request?.matchedResidentId === undefined || !request?.matchedResidentCode) return
    const residentId = String(request.matchedResidentId)
    const current = rotatedCodeByResidentId.get(residentId)
    const timestamp = Date.parse(request.verifiedAt || request.codeSentAt || request.updatedAt || request.submittedAt || '') || 0
    if (!current || timestamp >= current.timestamp) {
      rotatedCodeByResidentId.set(residentId, {
        code: String(request.matchedResidentCode).trim().toUpperCase(),
        timestamp,
      })
    }
  })

  const canonicalResidents = residents.map((resident) => {
    const rotatedCode = rotatedCodeByResidentId.get(String(resident.id))
    return rotatedCode && resident.code?.trim().toUpperCase() !== rotatedCode.code
      ? { ...resident, code: rotatedCode.code }
      : resident
  })
  const residentsByCode = new Map()
  canonicalResidents.forEach((resident) => {
    const code = String(resident?.code || '').trim().toUpperCase()
    if (!code) {
      residentsByCode.set(`unkeyed:${residentsByCode.size}`, resident)
      return
    }
    const existing = residentsByCode.get(code)
    if (!existing) {
      residentsByCode.set(code, resident)
      return
    }

    const canonical = String(resident.id) === code
      ? resident
      : String(existing.id) === code
        ? existing
        : getPersistedRecordTimestamp(resident) > getPersistedRecordTimestamp(existing)
          ? resident
          : existing
    const other = canonical === resident ? existing : resident
    const merged = { ...other, ...canonical }
    Object.entries(other).forEach(([key, value]) => {
      if ((merged[key] === undefined || merged[key] === null || merged[key] === '') && value !== undefined) {
        merged[key] = value
      }
    })
    residentsByCode.set(code, { ...merged, id: canonical.id, code })
  })
  return Array.from(residentsByCode.values())
}

const mapBackendRegistrationRequest = (application) => {
  const backendRegistrationId = Number(application?.id)
  if (!Number.isInteger(backendRegistrationId) || backendRegistrationId < 1) {
    throw new Error('The registration service returned an invalid application ID.')
  }
  const data = {
    firstName: application.first_name || '',
    middleName: application.middle_name || '',
    lastName: application.last_name || '',
    suffix: application.suffix || '',
    emailAddress: application.email || '',
    birthDate: application.date_of_birth || '',
    sex: application.sex || '',
    civilStatus: application.civil_status || '',
    mobileNumber: application.contact_number || '',
    houseBlockLot: application.house_no_street || '',
    streetPurok: application.purok || '',
    barangay: application.barangay || '',
    municipalityCity: application.city_municipality || '',
    province: application.province || '',
  }
  const name = [data.firstName, data.middleName, data.lastName, data.suffix].filter(Boolean).join(' ')
  const address = [
    data.houseBlockLot,
    data.streetPurok,
    data.barangay,
    data.municipalityCity,
    data.province,
  ].filter(Boolean).join(', ')

  return {
    id: `DB-REG-${backendRegistrationId}`,
    backendRegistrationId,
    registrationSource: 'account-registration',
    name,
    address,
    submittedAt: application.created_at || '',
    status: 'Pending',
    data,
    files: {},
    reviewSteps: {},
  }
}

const getResidentRecordAddressLabel = (resident, registrations) => {
  const fullAddress = String(resident.address || '').trim()
  const residentCode = String(resident.code || '').toLowerCase()
  const registration = registrations.find((candidate) => (
    candidate.status === 'Approved'
    && String(candidate.assignedResidentCode || '').toLowerCase() === residentCode
  ))
  const data = registration?.data
  if (!registration || !data || !fullAddress) return fullAddress

  const originalAddress = [
    data.houseBlockLot,
    data.streetPurok || data.purok,
    data.barangay,
    data.municipalityCity || data.city_municipality,
    data.province,
  ].filter(Boolean).join(', ')
  const normalizeAddress = (address) => String(address || '').trim().replace(/\s+/g, ' ').toLowerCase()
  if (normalizeAddress(fullAddress) !== normalizeAddress(registration.address)
    || normalizeAddress(fullAddress) !== normalizeAddress(originalAddress)) {
    return fullAddress
  }

  return [
    data.streetPurok || data.purok,
    data.municipalityCity || data.city_municipality,
  ].filter(Boolean).join(', ') || fullAddress
}

const migrateInitialResidentsToRegistrationHistory = (requests, residents) => {
  if (!Array.isArray(requests) || !Array.isArray(residents)) return requests
  const missingHistory = initialResidentRecords.flatMap((initialResident) => {
    const resident = residents.find((candidate) => (
      candidate.code?.toLowerCase() === initialResident.code.toLowerCase()
      || normalizeRecoveryIdentity(candidate.name) === normalizeRecoveryIdentity(initialResident.name)
    ))
    if (!resident) return []
    const normalizedName = normalizeRecoveryIdentity(resident.name)
    const alreadyRecorded = requests.some((request) => (
      request.assignedResidentCode?.toLowerCase() === resident.code?.toLowerCase()
      || normalizeRecoveryIdentity(request.name) === normalizedName
    ))
    if (alreadyRecorded) return []

    return [{
      id: `REG-EXISTING-${resident.code}`,
      name: resident.name,
      address: resident.address || '',
      submittedAt: '',
      reviewedAt: '',
      status: 'Approved',
      data: {
        fullName: resident.name,
        address: resident.address || '',
        birthDate: resident.birthDate || resident.dateOfBirth || '',
        mobileNumber: resident.contactNumber || resident.mobileNumber || '',
        emailAddress: resident.emailAddress || '',
      },
      files: {},
      assignedResidentCode: resident.code,
      importedFromResidentRecords: true,
    }]
  })
  return [...requests, ...missingHistory]
}

const generateResidentCode = (name, residents) => {
  const initials = String(name).trim().split(/\s+/)
    .map((part) => part[0].replace(/[^a-z0-9]/i, ''))
    .filter(Boolean)
    .join('')
    .slice(0, 3)
    .toUpperCase() || 'RES'
  let sequence = residents.length + 1
  let code = `BB1-${initials}-${String(sequence).padStart(3, '0')}`
  while (residents.some((resident) => String(resident.code || '').toLowerCase() === code.toLowerCase())) {
    sequence += 1
    code = `BB1-${initials}-${String(sequence).padStart(3, '0')}`
  }
  return code
}

const loadAdminPreferences = () => {
  try {
    const saved = window.localStorage.getItem(adminPreferencesStorageKey)
    const preferences = saved ? JSON.parse(saved) : {}
    return {
      darkMode: Boolean(preferences.darkMode),
      fontSize: preferences.fontSize === 'large' ? 'large' : 'standard',
      autoLogoutMinutes: [0, 15, 30, 60].includes(Number(preferences.autoLogoutMinutes))
        ? Number(preferences.autoLogoutMinutes)
        : 30,
    }
  } catch (error) {
    console.error('Unable to load admin preferences from browser storage.', error)
    return { darkMode: false, fontSize: 'standard', autoLogoutMinutes: 30 }
  }
}

const loadDocumentWorkflowViewedState = () => {
  try {
    const saved = window.localStorage.getItem(documentWorkflowViewedStorageKey)
    if (!saved) return {}
    const viewedState = JSON.parse(saved)
    if (!viewedState || typeof viewedState !== 'object' || Array.isArray(viewedState)
      || !Object.values(viewedState).every((token) => typeof token === 'string')) {
      throw new Error('Saved document workflow view state is invalid.')
    }
    return viewedState
  } catch (error) {
    console.error('Unable to load document workflow view state.', error)
    return {}
  }
}

const getAdminDeviceLabel = () => {
  const userAgent = window.navigator.userAgent
  const browser = /Edg\//.test(userAgent) ? 'Microsoft Edge'
    : /Chrome\//.test(userAgent) ? 'Google Chrome'
      : /Firefox\//.test(userAgent) ? 'Mozilla Firefox'
        : /Safari\//.test(userAgent) ? 'Safari'
          : 'Unknown browser'
  const platform = window.navigator.userAgentData?.platform || window.navigator.platform || 'Unknown device'
  return `${browser} · ${platform}`
}

const poblacionOrigin = 'Ang Poblacion ay Sentrong Bayan ng Bongabong, pag-aari ng tatlong pamilya: Lazaro, Casilag at Umali. Tinagurian itong “Madalang ang tao sa Poblacion o Sentrong Bayan.”'

const poblacionHistory = [
  { year: '1961', text: 'Naluklok si Mayor Felipe Manalo. Napansin niya ang malawak na bahagi ng Poblacion o LACASUMA kaya tinawag niya itong PARANG.' },
  { year: '1964–1967', text: 'Mayor Ernesto “Barurot” Umali. Zone Leader sa Parang: G. Romeo Caballero.' },
  { year: '1970', text: 'Mayor Pedrito Reyes. Zone Leader: Dr. Alfredo Santos.' },
  { year: '1972', text: 'Nagkaroon ng halalan habang umiiral ang Martial Law. Naiukiok sa pwesto si Mayor Jose “Ute” Enriquez. Zone Leader: Atty. Faustino Diaz.' },
  { year: '1980', text: 'Naging Mayor si G. Renato “Kato” Reyes.' },
  { year: '1983', text: 'Hinati ang Poblacion o LACASUMA. Zone Leader sa Bagong Bayan I at II si Ramon Ylagan. Nang mangibang bansa siya, ang kapalit ay si G. Dayo Casao.' },
  { year: '1983', text: 'Nahati ang Poblacion sa limang (5) barangay: Poblacion, Aplaya, Ipil, Bagong Bayan-I at Bagong Bayan-II (mga lugar na sakop ng Flores De Mayo).' },
]

const lowLyingAreaFacts = [
  '42.7309 ektarya, kasama ang mga palaisdaan ng Saguinsin, Arzobal Family, at ang 2-ektaryang palaisdaan ni Mr. Lumague.',
  'Kasama ang Sukol River (may sasa/nipa sa gilid): 1,042.88 metro ang haba, 20 metro ang luwang.',
  'Dating makasaysayan ang ilog dahil sa dalawang malalaking isda (Kugtong) na nagpapakita tuwing pista sa Sukol at Tayukoy River. Binabaril sila ng masasamang loob, at huling nakita noong 2005.',
  'Unti-unting nawalan ng sigla ang ilog at dumami ang basura. Sasa na lang ang pangunahing ikinabubuhay ng mga may-ari at manggagawang bukid, kasama ang kaunting nakukuha sa likas na yaman ng Sukol River.',
  'Hangganan: Timog at Kanluran – Brgy. Malitbog (kung saan tumatahak ang Nautical Highway Diversion Road at ang tulay papatawid sa Tayukoy River). Silangan – Brgy. Ipil.',
]

const elevatedAreaFacts = [
  'Lawak: 25.2831 ektarya, kasama ang Horizontal at Lateral Road.',
  'Hangganan: Hilaga – Brgy. Bagong Bayan-II, na ang pagitan ay ang Provincial Road o Rizal Avenue.',
  'Sukat ng lote: 15 x 20 metro (maliban sa Block 21). Ang 20 metro ay paayon, may dalawang datig sa harap (20+20 = 40 metro), at ang 15 metro ang lapad papasok sa barangay.',
  'Mga daan: Block 1 hanggang 10 ay tatawaging Balite Drive. Mula Isler Street hanggang P. Caberto St. ay Barangay Road. May Roosevelt Avenue rin at lote sa paligid nito.',
  'Ang 40 metrong sukat sa harap na may kalye sa magkabila ay tatawaging 1 block. Ang mga kalyeng namamagitan sa bawat block ay 8 metro ang luwang.',
]

const zoneHistory = [
  'Ang barangay ay may 21 blocks at 22 streets, hinati sa pitong (7) sona, isa para sa bawat kagawad.',
  'Zone I: 4 na kalye at 3 bloke. Ang iba pang sona ay may tig-3 bloke at 3 kalye.',
  'Ang pagtatalaga ng kagawad sa bawat sona ay ayon sa pagkakasunod-sunod ng mga kagawad noong 2013 Barangay Election. Ang ikapitong (7) kagawad ay para sa Sona Siete / Zone Seven (Area of Responsibility niya).',
  'Masaya at tahimik sa Sona Siete. Maraming relihiyon ang nakatira rito, pero ito ang lugar na pinakamabongga noong aktibo pa ang Tanglaw Diwa Flores De Mayo. Patuloy pa rin ang tradisyon pero hindi na kasing luho o bongga gaya noon.',
]

const firstBarangayOfficials = [
  'Kapitan Rogelio Villalubos',
  'Kagawad Victor Ramos',
  'Kagawad Pablito Babao',
  'Kagawad Rodolfo A. Dimaculangan',
  'Kagawad Maximo Casapao',
  'Kagawad Isagani Miraples',
  'Kagawad Maura Salvacion',
  'KB Chairman Jose A. Dimaculangan Jr.',
]

const edsaOicOfficials = [
  'OIC Captain Constancio B. Cudiamat',
  'Kagawad Victoriano Ramos',
  'Kagawad Redentor Villapa',
  'Kagawad Casiano Amigo',
]

const barangayHistoryPhotos = [
  { src: '/about-history/barangay-hall-front.png', alt: 'Front of the Barangay Bagong Bayan-I Hall', caption: 'Barangay Bagong Bayan-I Hall' },
  { src: '/about-history/barangay-hall-view.png', alt: 'Another view of the Barangay Bagong Bayan-I Hall', caption: 'Barangay Bagong Bayan-I Hall' },
  { src: '/about-history/barangay-spot-map-cropped.png', alt: 'Spot map showing Bagong Bayan-I, its seven zones, landmarks, and nearby barangays', caption: 'Spot map of Barangay Bagong Bayan-I' },
  { src: '/about-history/barangay-council.png', alt: 'Framed photograph labeled Barangay Bagong Bayan I Council', caption: 'Barangay Bagong Bayan I Council' },
  { src: '/about-history/barangay-records-board.png', alt: 'Barangay documents displayed on a bulletin board', caption: 'Barangay records and documents' },
]

const communityZoneDetails = [
  { name: 'ZONE I', position: 'West side', blocks: 3, streets: 4, focus: { x: 0.32, y: 0.37 } },
  { name: 'ZONE II', position: 'Southeast end by Ipil', blocks: 3, streets: 3, focus: { x: 0.76, y: 0.67 } },
  { name: 'ZONE III', position: 'South-central', blocks: 3, streets: 3, focus: { x: 0.61, y: 0.61 } },
  { name: 'ZONE IV', position: 'Central-south', blocks: 3, streets: 3, focus: { x: 0.68, y: 0.66 } },
  { name: 'ZONE V', position: 'Central area', blocks: 3, streets: 3, focus: { x: 0.53, y: 0.55 } },
  { name: 'ZONE VI', position: 'North-central, near the barangay hall', blocks: 3, streets: 3, focus: { x: 0.43, y: 0.45 } },
  { name: 'ZONE VII', position: 'Northwest end by Malitbog', blocks: 3, streets: 3, focus: { x: 0.32, y: 0.37 } },
]

const CommunityMapGuide = () => {
  const [selectedZoneName, setSelectedZoneName] = useState('')
  const mapViewportRef = useRef(null)
  const selectedZone = communityZoneDetails.find((zone) => zone.name === selectedZoneName)
  const zoomScale = 2.25
  const mapTransform = selectedZone
    ? `translate(${50 - selectedZone.focus.x * zoomScale * 100}%, ${50 - selectedZone.focus.y * zoomScale * 100}%) scale(${zoomScale})`
    : 'translate(0%, 0%) scale(1)'

  const selectZone = (zone) => {
    setSelectedZoneName(zone.name)
  }

  return (
    <>
      <div className="startup-about-map-zones">
        <figure className={`startup-zone-map${selectedZone ? ' has-selected-zone' : ''}`}>
          <div className="startup-zone-map-viewport" ref={mapViewportRef} role="group" aria-label={selectedZone ? `Map zoomed to ${selectedZone.name}, ${selectedZone.position}` : 'Barangay spot map'}>
            <div className="startup-zone-map-canvas" style={{ transform: mapTransform }}>
              <img src={barangayHistoryPhotos[2].src} alt={barangayHistoryPhotos[2].alt} loading="lazy" />
            </div>
            {selectedZone && <>
              <span className="startup-zone-focus-marker" aria-hidden="true"><span>{selectedZone.name.replace('ZONE ', 'Z')}</span></span>
              <button type="button" className="startup-zone-map-reset" onClick={() => setSelectedZoneName('')}>Show full map</button>
            </>}
          </div>
          <figcaption>
            <span>BARANGAY SPOT MAP</span>
            <strong>Seven zones · local landmarks · community boundaries</strong>
            {selectedZone && <p className="startup-zone-map-guidance" aria-live="polite">{selectedZone.name}: {selectedZone.position}. Approximate area highlighted on the main map; north is up.</p>}
          </figcaption>
        </figure>
        <div className="startup-zone-guide" aria-label="Each zone and its approximate position on the map">
          <p className="startup-map-details-label">ALL ZONES · APPROXIMATE MAP POSITION</p>
          <div className="startup-zone-list">
            {communityZoneDetails.map((zone) => (
              <button
                type="button"
                className={`startup-zone-button${selectedZoneName === zone.name ? ' is-selected' : ''}`}
                aria-pressed={selectedZoneName === zone.name}
                key={zone.name}
                onClick={() => selectZone(zone)}
              >
                <strong>{zone.name}</strong>
                <span>{zone.position} · {zone.blocks} blocks · {zone.streets} streets</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="startup-map-details" aria-label="Details shown on the spot map">
        <p className="startup-map-details-label">DIRECTIONS &amp; MAP LEGEND</p>
        <div className="startup-map-details-grid">
          <div className="startup-map-directions">
            <p className="startup-map-north-note">North arrow points up on the map.</p>
            <div className="startup-direction-grid">
              <div><strong>NORTH ↑</strong><span>Barangay Bagong Bayan-II</span></div>
              <div><strong>WEST ←</strong><span>Barangay Malitbog</span></div>
              <div><strong>SOUTH ↓</strong><span>Barangay Ipil</span></div>
              <div><strong>EAST / NORTHEAST ↗</strong><span>Barangay Aplaya</span></div>
            </div>
          </div>
          <div className="startup-map-legend">
            <div className="startup-map-legend-row"><strong>Facilities</strong><span>Barangay hall, basketball court, boundary landmark, private clinic, school, and church.</span></div>
            <div className="startup-map-legend-row"><strong>Other markers</strong><span>Commercial spaces, warehouses, flood-prone areas, and no-, low-, medium-, and high-risk HH markers.</span></div>
          </div>
        </div>
      </div>
    </>
  )
}

const historyIconContent = {
  timeline: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3 2" /></>,
  community: <><path d="m3 10 9-7 9 7" /><path d="M5 9v12h14V9M9 21v-7h6v7" /></>,
  area: <><rect x="3.5" y="4" width="17" height="16" rx="2" /><path d="M3.5 10h17M9 4v16M15 10v10" /></>,
  zones: <><path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" /><path d="m4 7.5 8 4.7 8-4.7M12 12.2V21" /></>,
  election: <><path d="M4 10h16v10H4zM7 10V4h10v6M8 14l2 2 5-5" /></>,
  edsa: <><path d="m12 3 2.4 5 5.5.8-4 3.9.9 5.5-4.8-2.6-4.8 2.6.9-5.5-4-3.9 5.5-.8L12 3Z" /></>,
  edit: <><path d="M12 20h9" /><path d="m16.5 3.5 4 4L9 19l-5 1 1-5L16.5 3.5Z" /></>,
  contact: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M9 7h6M9 11h6M9 15h3" /></>,
}

const AboutHistoryIcon = ({ type }) => (
  <span className="about-history-icon" aria-hidden="true">
    <svg viewBox="0 0 24 24">{historyIconContent[type]}</svg>
  </span>
)

const weekDaysMondayFirst = [{ label: 'Mon', day: 1 }, { label: 'Tue', day: 2 }, { label: 'Wed', day: 3 }, { label: 'Thu', day: 4 }, { label: 'Fri', day: 5 }, { label: 'Sat', day: 6 }, { label: 'Sun', day: 0 }]
const initialAvailability = [
  { id: 'captain', name: 'Barangay Captain', role: 'Document approval', days: [1, 3, 5], hours: '9:00 AM - 12:00 PM' },
  { id: 'secretary', name: 'Barangay Secretary', role: 'Document processing & release', days: [1, 2, 3, 4, 5], hours: '1:00 PM - 4:00 PM' },
]

const initialRequests = [
  { id: 'BR-2026-001', resident: 'Xyrell P. Guerra', residentCode: 'BB1-JG-004', documents: ['Barangay Clearance', 'Certificate of Residency'], date: 'Sep 13, 2026', status: 'New', details: { address: 'Purok 3, Barangay Bagong Bayan 1', contactNumber: '0917 555 0182', birthDate: '1994-06-18', purpose: 'Employment requirement' }, requirements: ['Valid government ID (front and back)', 'Proof of residency'], activity: [{ action: 'Request submitted', by: 'Resident', time: 'Sep 13, 2026, 9:15 AM' }] },
  { id: 'BR-2026-002', resident: 'Percimhe V. Masuba', residentCode: 'BB1-SD-005', documents: ['Good Moral'], date: 'Sep 12, 2026', status: 'Under review', details: { address: 'Purok 1, Barangay Bagong Bayan 1', contactNumber: '0918 321 7410', birthDate: '2002-11-04', purpose: 'School scholarship application' }, requirements: ['Valid government ID (front and back)', 'School request letter'], activity: [{ action: 'Request submitted', by: 'Resident', time: 'Sep 12, 2026, 10:02 AM' }, { action: 'Set for review', by: 'Barangay Secretary', time: 'Sep 12, 2026, 2:30 PM' }] },
  { id: 'BR-2026-003', resident: 'Francis Harvey P. Linga', residentCode: 'BB1-JDC-001', documents: ['Business Clearance', 'Certificate of Business Disclosure'], date: 'Sep 11, 2026', status: 'New', details: { address: 'Purok 5, Barangay Bagong Bayan 1', contactNumber: '0919 888 1024', birthDate: '1987-03-22', purpose: 'Business permit renewal' }, requirements: ['Valid government ID (front and back)', 'Business permit or registration', 'Proof of business address', 'List of business details'], activity: [{ action: 'Request submitted', by: 'Resident', time: 'Sep 11, 2026, 3:48 PM' }] },
]

const residentNameMatches = (registeredName, enteredName, registeredData = {}) => {
  const toTokens = (value) => String(value || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .map((token) => token.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
  const enteredFirst = toTokens(enteredName.firstName)
  const enteredMiddle = toTokens(enteredName.middleName)
  const enteredLast = toTokens(enteredName.lastName)
  const enteredSuffix = toTokens(enteredName.suffix)
  const structuredName = [
    registeredData.firstName,
    registeredData.middleName,
    registeredData.lastName,
    registeredData.suffix,
  ].filter(Boolean).join(' ')
  const registeredTokens = toTokens(structuredName || registeredName)
  const findSequence = (tokens, sequence, start, end = tokens.length) => {
    for (let index = start; index <= end - sequence.length; index += 1) {
      if (sequence.every((token, offset) => tokens[index + offset] === token)) return index
    }
    return -1
  }
  if (!enteredFirst.length || !enteredLast.length || !enteredFirst.every((token, index) => registeredTokens[index] === token)) return false
  const firstEnd = enteredFirst.length
  const lastStart = findSequence(registeredTokens, enteredLast, firstEnd)
  if (lastStart < 0) return false
  if (enteredMiddle.length && findSequence(registeredTokens, enteredMiddle, firstEnd, lastStart) < 0) return false
  return !enteredSuffix.length || findSequence(registeredTokens, enteredSuffix, lastStart + enteredLast.length) >= 0
}
const normalizeResidentCode = (value) => String(value || '').trim().toUpperCase()
const residentNameFieldsFromFullName = (value) => {
  const parts = String(value || '').trim().split(/\s+/).filter(Boolean)
  const suffixToken = (parts[parts.length - 1] || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])
  const suffix = suffixes.has(suffixToken) ? parts.pop() : ''
  return {
    firstName: parts.shift() || '',
    middleName: parts.length > 1 ? parts.slice(0, -1).join(' ') : '',
    lastName: parts.length ? parts[parts.length - 1] : '',
    suffix,
  }
}
const residentRecordMatchesAccount = (record, resident) => {
  const recordCode = normalizeResidentCode(record.residentCode || record.resident_code)
  const currentCode = normalizeResidentCode(resident.code)
  const registeredName = record.resident || record.name || record.fullName || record.full_name || ''
  return recordCode
    ? recordCode === currentCode
    : residentNameMatches(registeredName, resident, record.data || record)
}

const mergeResidentSyncRecords = (currentRecords, remoteRecords, resident, archivedIds = new Set()) => {
  const uniqueRemoteRecords = uniqueResidentRequestsById(remoteRecords)
  const remoteIds = new Set(uniqueRemoteRecords.map((record) => record?.id).filter(Boolean))
  const remoteOwned = uniqueRemoteRecords.filter((record) => !archivedIds.has(record?.id))
  const localOnlyOwned = currentRecords.filter((record) => (
    residentRecordMatchesAccount(record, resident)
    && !remoteIds.has(record?.id)
    && !archivedIds.has(record?.id)
  ))
  const otherResidents = currentRecords.filter((record) => !residentRecordMatchesAccount(record, resident))
  return uniqueResidentRequestsById([...remoteOwned, ...localOnlyOwned, ...otherResidents])
}

const residentStatusLabels = {
  New: 'Submitted',
  'For Verification': 'For verification',
  'Under review': 'Under review',
  'Approved - scheduling': 'Documents being prepared',
  'Returned for edits': 'Edits requested',
  'Ready for release': 'Ready for pickup',
  Completed: 'Received',
  Declined: 'Declined',
  Cancelled: 'Cancelled',
}

const documentWorkflowViewStatuses = new Set([
  'New',
  'For Verification',
  'Returned for edits',
  'Under review',
  'Approved - scheduling',
  'Ready for release',
])

const getDocumentWorkflowViewToken = (request) => {
  const currentStatus = request.status === 'For Verification' ? 'Under review' : request.status
  const entries = (request.statusHistory || []).filter((entry) => (
    (entry.status === 'For Verification' ? 'Under review' : entry.status) === currentStatus
  ))
  const latestEntry = entries[entries.length - 1]
  const stageViewRevision = request.status === 'Approved - scheduling' ? ':certificate-template-v1' : ''
  return `${request.status}:${latestEntry?.changedAt || request.updatedAt || request.requestedAt || request.date || ''}:${entries.length}${stageViewRevision}`
}

const isDocumentWorkflowUnviewed = (request, viewedState) => (
  documentWorkflowViewStatuses.has(request.status)
  && viewedState[request.id] !== getDocumentWorkflowViewToken(request)
)

const requestTrackingSteps = [
  { key: 'submitted', label: 'Submitted', statuses: ['New', 'Submitted'] },
  { key: 'under-review', label: 'Under review', statuses: ['For Verification', 'Under review'] },
  { key: 'edits-requested', label: 'Edits requested', statuses: ['Returned for edits'] },
  { key: 'processing', label: 'Processing documents', statuses: ['Approved - scheduling'] },
  { key: 'ready-for-pickup', label: 'Ready for pickup', statuses: ['Ready for pickup', 'Ready for release'] },
  { key: 'released', label: 'Received', statuses: ['Completed', 'Released'] },
]

const getRequestTrackingStep = (status) => requestTrackingSteps.find((step) => step.statuses.includes(status))

const formatRequestTrackingDate = (date) => {
  if (!date) return 'Date not recorded'
  const parsedDate = new Date(date)
  return Number.isNaN(parsedDate.getTime())
    ? 'Date not recorded'
    : parsedDate.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
}

const formatPickupSchedule = (date, time) => {
  if (!date) return 'Schedule not set'
  const parsedDate = new Date(`${date}T${time || '12:00'}`)
  if (Number.isNaN(parsedDate.getTime())) return [date, time].filter(Boolean).join(' · ')
  return parsedDate.toLocaleString('en-PH', time
    ? { dateStyle: 'full', timeStyle: 'short' }
    : { dateStyle: 'full' })
}

const formatPickupDate = (date) => {
  if (!date) return 'Not scheduled yet'
  const parsedDate = new Date(`${date}T00:00:00`)
  return Number.isNaN(parsedDate.getTime())
    ? date
    : parsedDate.toLocaleDateString('en-PH', { dateStyle: 'full' })
}

const formatPickupTime = (time) => {
  if (!time) return 'Not scheduled yet'
  const parsedTime = new Date(`2000-01-01T${time}`)
  return Number.isNaN(parsedTime.getTime())
    ? time
    : parsedTime.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' })
}

const getLocalDateInputValue = (date = new Date()) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 10)

function RequestTrackingTimeline({ request }) {
  const statusHistory = request.statusHistory || withRequestStatusHistory(request).statusHistory
  const stepDates = new Map()
  statusHistory.forEach((entry) => {
    const step = getRequestTrackingStep(entry.status)
    if (step) stepDates.set(step.key, entry.changedAt)
  })

  const currentStep = getRequestTrackingStep(request.status)
  const isDeclined = request.status === 'Declined'
  const isCancelled = request.status === 'Cancelled'
  const reachedIndex = currentStep
    ? requestTrackingSteps.findIndex((step) => step.key === currentStep.key)
    : Math.max(-1, ...statusHistory.map((entry) => requestTrackingSteps.findIndex((step) => step.key === getRequestTrackingStep(entry.status)?.key)))
  const declinedEntry = request.status === 'Declined'
    ? statusHistory.slice().reverse().find((entry) => entry.status === 'Declined')
    : null
  const cancelledEntry = isCancelled
    ? statusHistory.slice().reverse().find((entry) => entry.status === 'Cancelled')
    : null

  return (
    <div className="request-tracking">
      <section className="request-tracking-timeline" aria-label={`Request tracking timeline for ${request.id}`}>
        <h3>Processing progress</h3>
        <ol>
          {requestTrackingSteps.map((step, index) => {
            const completed = index < reachedIndex || (index === reachedIndex && (
              !isDeclined || statusHistory.some((entry) => getRequestTrackingStep(entry.status)?.key === step.key)
            ))
            const current = index === reachedIndex && !isDeclined && !isCancelled
            const terminalDeclined = isDeclined && step.key === 'released'
            const date = terminalDeclined
              ? declinedEntry?.changedAt
              : stepDates.get(step.key) || (step.key === 'submitted' ? request.requestedAt || request.date : '')
            return (
              <li className={`${completed ? 'is-complete' : ''} ${current ? 'is-current' : ''} ${terminalDeclined ? 'is-declined' : ''}`} key={step.key}>
                <span className="request-tracking-marker" aria-hidden="true">{terminalDeclined ? '!' : completed ? '✓' : index + 1}</span>
                <div><strong>{terminalDeclined ? 'Declined' : step.label}</strong><time>{date ? formatRequestTrackingDate(date) : completed ? 'Date not recorded' : 'Not reached yet'}</time></div>
              </li>
            )
          })}
          {isCancelled && <li className="is-cancelled"><span className="request-tracking-marker" aria-hidden="true">×</span><div><strong>Cancelled</strong><time>{formatRequestTrackingDate(cancelledEntry?.changedAt || request.cancelledAt)}</time></div></li>}
        </ol>
      </section>
    </div>
  )
}

function ResidentRequestDetailContent({ request, relatedRequests, customTemplates = [] }) {
  const requestDetails = getResidentRequestDetailEntries(request)
  const uploadedPhotos = getResidentRequestPhotos(request, relatedRequests, customTemplates)
  const officeUpdates = (request.activity || [])
    .filter((entry) => !/^request submitted$/i.test(String(entry.action || '').trim()))
    .slice()
    .reverse()
  const feeAmount = Number(request.feeAmount ?? (
    Number(request.unitFeeAmount || 0) * (Number(request.copyCount) || 1)
  ))
  const paymentStatusLabel = request.paymentStatus === 'Paid'
    ? 'Paid'
    : request.paymentStatus === 'Pending verification'
      ? 'Pending verification'
      : request.paymentStatus === 'Unpaid'
        ? 'Unpaid'
        : 'Payment not recorded'

  return (
    <>
      <RequestTrackingTimeline request={request} />
      {request.pickupDate && <p className="resident-pickup-notice">Pickup schedule: <strong>{formatPickupSchedule(request.pickupDate, request.pickupTime)}</strong>{request.pickupInstructions && <span>{request.pickupInstructions}</span>}</p>}
      {request.status === 'Ready for release' && !request.pickupNotificationSentAt && <p className="resident-pickup-notice">Your documents are ready for release. Pickup date, time, and instructions will be shared soon.</p>}
      {request.status === 'Returned for edits' && request.editRequestNote && <div className="resident-decline-notice"><p><strong>Edits requested:</strong> {request.editRequestNote}</p></div>}
      {request.declineReason && <div className="resident-decline-notice"><p><strong>Reason for decline:</strong> {request.declineReason}</p><span>Requirements to correct: {(request.invalidRequirements || []).join(' · ') || 'Please contact the barangay office.'}</span></div>}
      {feeAmount > 0 && <section className="resident-request-payment-summary" aria-label="Payment summary">
        <div><span>Payment status</span><strong>{paymentStatusLabel}: ₱{feeAmount.toFixed(2)}</strong></div>
        {request.paymentMethod && <div><span>Method</span><strong>{request.paymentMethod === 'gcash' ? 'GCash' : request.paymentMethod === 'walk-in' ? 'Walk-in' : request.paymentMethod}</strong></div>}
        {request.paymentSubmittedAt && <div><span>Submitted</span><strong>{formatRequestTrackingDate(request.paymentSubmittedAt)}</strong></div>}
        {request.paymentVerifiedAt && <div><span>Confirmed</span><strong>{formatRequestTrackingDate(request.paymentVerifiedAt)}</strong></div>}
        {request.paymentOrNumber && <div><span>Official receipt</span><strong>{request.paymentOrNumber}</strong></div>}
      </section>}
      <section className="resident-request-information resident-request-submitted-information">
        <h3>Information you submitted</h3>
        {requestDetails.length
          ? <dl>{requestDetails.map(([label, value]) => (
            <div key={label}>
              <dt>{label.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')}</dt>
              <dd>{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
            </div>
          ))}</dl>
          : <p className="resident-request-empty-detail">No submitted information was saved with this request.</p>}
      </section>
      <section className="resident-request-detail-section resident-request-photos-section">
        <div className="resident-request-detail-section-heading">
          <div><h3>Photos you submitted</h3><p>Requirement photos attached to this document.</p></div>
          {uploadedPhotos.length > 0 && <span>{uploadedPhotos.length} photo{uploadedPhotos.length === 1 ? '' : 's'}</span>}
        </div>
        {uploadedPhotos.length
          ? <ResidentPhotoGallery documentName={request.documents?.join(' · ') || 'Document request'} photos={uploadedPhotos} />
          : <p className="resident-request-empty-detail">No image data is saved with this request. File names alone cannot be shown as photos.</p>}
      </section>
      <details className="resident-update-history">
        <summary>Office updates and history ({officeUpdates.length})</summary>
        {officeUpdates.length
          ? <ol>{officeUpdates.map((entry, index) => <li key={`${entry.time}-${index}`}><strong>{entry.action}</strong><span>{entry.by} · {entry.time}</span></li>)}</ol>
          : <p className="resident-request-empty-detail">No additional office updates yet.</p>}
      </details>
    </>
  )
}

function ResidentCorrectionResubmission({ request, onSubmit, customTemplates = [] }) {
  const invalidKeys = Array.isArray(request.invalidRequirements) ? request.invalidRequirements : []
  const savedPhotos = getRequestPhotos(request)
  const photosToReplace = invalidKeys
    .map((photoKey) => savedPhotos.find((photo) => photo.photoKey === photoKey))
    .filter(Boolean)
  const certificateFieldsToCorrect = getCertificateCorrectionFields(request, customTemplates)
    .filter(({ correctionKey }) => invalidKeys.includes(correctionKey))
  const certificateCorrectionKeys = new Set(certificateFieldsToCorrect.map(({ correctionKey }) => correctionKey))
  const [replacementPhotos, setReplacementPhotos] = useState({})
  const [correctedFieldValues, setCorrectedFieldValues] = useState(() => Object.fromEntries(
    certificateFieldsToCorrect.map(({ correctionKey, value }) => [correctionKey, value]),
  ))
  const [step, setStep] = useState('edit')
  const [isPreparingPhoto, setIsPreparingPhoto] = useState(false)
  const [error, setError] = useState('')
  const canReview = invalidKeys.length > 0
    && photosToReplace.length + certificateFieldsToCorrect.length === invalidKeys.length
    && invalidKeys.every((key) => replacementPhotos[key]
      || (certificateCorrectionKeys.has(key) && String(correctedFieldValues[key] || '').trim()))
    && !isPreparingPhoto

  const handlePhotoChange = async (event, photoKey) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError('')
    setIsPreparingPhoto(true)
    try {
      const photo = await createRequirementPhoto(file)
      setReplacementPhotos((currentPhotos) => ({ ...currentPhotos, [photoKey]: photo }))
    } catch (photoError) {
      console.error('Unable to prepare a corrected requirement photo.', photoError)
      setError(`${file.name}: ${photoError.message}`)
      event.target.value = ''
    } finally {
      setIsPreparingPhoto(false)
    }
  }

  const updateCorrectedField = (correctionKey, value) => {
    setCorrectedFieldValues((currentValues) => ({ ...currentValues, [correctionKey]: value }))
  }

  const handleReview = (event) => {
    event.preventDefault()
    if (!canReview) {
      setError('Complete every requested information field and upload a replacement for each requested photo.')
      return
    }
    setError('')
    setStep('review')
  }

  const handleSubmit = () => {
    if (!canReview) {
      setError('Complete every requested information field and upload a replacement for each requested photo.')
      setStep('edit')
      return
    }
    if (!onSubmit(request, { photos: replacementPhotos, certificateFields: correctedFieldValues })) {
      setError('The corrections could not be submitted. Please review the required information and files, then try again.')
    }
  }

  return (
    <section className="resident-correction-resubmission" aria-labelledby="resident-correction-title">
      <header>
        <span className="section-number">CORRECTION REQUIRED</span>
        <h3 id="resident-correction-title">{step === 'edit' ? 'Correct the requested information' : 'Review your corrections'}</h3>
        <p>{step === 'edit'
          ? 'Update the requested certificate information and replace any files requested by the barangay office.'
          : 'Check each update before sending this request back to the barangay office.'}</p>
      </header>
      {step === 'edit' ? (
        photosToReplace.length + certificateFieldsToCorrect.length === invalidKeys.length && invalidKeys.length > 0 ? (
          <form className="resident-correction-resubmission-form" onSubmit={handleReview}>
            {certificateFieldsToCorrect.map(({ document, field, correctionKey, value }) => {
              const correctedValue = correctedFieldValues[correctionKey] ?? value
              const fieldId = `correction-${correctionKey}`
              return (
                <div className="resident-correction-upload" key={correctionKey}>
                  <label htmlFor={fieldId}>{document} · {field.label}</label>
                  <small>Current value: {formatCertificateReviewValue(value)}</small>
                  {field.isCheckbox && field.options?.length
                    ? <fieldset className="certificate-field-options">
                      <legend>{field.label}</legend>
                      <div>{field.options.map((option) => {
                        const selected = field.multiple
                          ? Array.isArray(correctedValue) && correctedValue.includes(option)
                          : correctedValue === option
                        return <label className={selected ? 'checked' : ''} key={option}>
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => {
                              if (field.multiple) {
                                const selections = Array.isArray(correctedValue) ? correctedValue : []
                                updateCorrectedField(correctionKey, selected
                                  ? selections.filter((selection) => selection !== option)
                                  : [...selections, option])
                              } else {
                                updateCorrectedField(correctionKey, selected ? '' : option)
                              }
                            }}
                          />
                          <span>{option}</span>
                        </label>
                      })}</div>
                    </fieldset>
                    : field.type === 'textarea'
                      ? <textarea id={fieldId} value={correctedValue} onChange={(event) => updateCorrectedField(correctionKey, event.target.value)} required />
                      : field.options?.length
                        ? <select id={fieldId} value={correctedValue} onChange={(event) => updateCorrectedField(correctionKey, event.target.value)} required>
                          <option value="" disabled>Select {field.label.toLowerCase()}</option>
                          {field.options.map((option) => <option value={option} key={option}>{option}</option>)}
                        </select>
                        : <input id={fieldId} type={field.type || 'text'} value={correctedValue} onChange={(event) => updateCorrectedField(correctionKey, event.target.value)} required />}
                </div>
              )
            })}
            {photosToReplace.map((photo) => (
              <label className="resident-correction-upload" key={photo.photoKey}>
                <span>{photo.document ? `${photo.document} · ` : ''}{photo.label}</span>
                <small>Current file: {photo.fileName || 'Uploaded image'}</small>
                <input type="file" accept="image/*" capture="environment" onChange={(event) => handlePhotoChange(event, photo.photoKey)} required={!replacementPhotos[photo.photoKey]} />
                <small>{replacementPhotos[photo.photoKey]?.fileName || 'Choose a clear replacement image'}</small>
              </label>
            ))}
            {error && <p className="resident-correction-error" role="alert">{error}</p>}
            <button type="submit" className="check-button" disabled={!canReview}>Review corrections</button>
          </form>
        ) : (
          <p className="resident-correction-error" role="alert">Some requested corrections are not available in this request. Please contact the barangay office for help.</p>
        )
      ) : (
        <>
          <div className="resident-correction-review-list">
            {certificateFieldsToCorrect.map(({ document, field, correctionKey, value }) => (
              <article key={correctionKey}>
                <h4>{document} · {field.label}</h4>
                <dl>
                  <div><dt>Current value</dt><dd>{formatCertificateReviewValue(value)}</dd></div>
                  <div><dt>Corrected value</dt><dd>{formatCertificateReviewValue(correctedFieldValues[correctionKey])}</dd></div>
                </dl>
              </article>
            ))}
            {photosToReplace.map((photo) => {
              const replacement = replacementPhotos[photo.photoKey]
              return (
                <article key={photo.photoKey}>
                  <h4>{photo.document ? `${photo.document} · ` : ''}{photo.label}</h4>
                  <div>
                    <figure><img src={photo.dataUrl} alt={`Current ${photo.label}`} /><figcaption>Current file</figcaption></figure>
                    <figure><img src={replacement.dataUrl} alt={`Replacement ${photo.label}`} /><figcaption>{replacement.fileName}</figcaption></figure>
                  </div>
                </article>
              )
            })}
          </div>
          <p className="resident-correction-submit-note">Submitting sends these corrected fields and files with this same request for review. No new request or payment is created.</p>
          {error && <p className="resident-correction-error" role="alert">{error}</p>}
          <div className="resident-correction-review-actions">
            <button type="button" className="cancel-button" onClick={() => setStep('edit')}>Back to editing</button>
            <button type="button" className="check-button" onClick={handleSubmit}>Submit corrections</button>
          </div>
        </>
      )}
    </section>
  )
}

function ResidentRequestDetailDialog({ request, relatedRequests, onClose, onSubmitCorrection, customTemplates = [] }) {
  const requestDate = request.requestedAt
    ? new Date(request.requestedAt).toLocaleDateString('en-US', { dateStyle: 'medium' })
    : request.date || 'Date not recorded'
  const statusClass = request.status.toLowerCase().replace(/[^a-z]+/g, '-')

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return createPortal(
    <div className="resident-request-detail-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <article className="resident-request-detail-page resident-request-detail-dialog" role="dialog" aria-modal="true" aria-labelledby="resident-request-detail-title">
        <header className="resident-request-detail-dialog-heading">
          <div className="resident-request-detail-heading">
            <div>
              <p className="resident-inbox-request-id">{request.id} · Submitted {requestDate}</p>
              <h2 id="resident-request-detail-title">{request.documents.join(' · ')}</h2>
            </div>
            <span className={`resident-status-badge ${statusClass}`}>{residentStatusLabels[request.status] || request.status}</span>
          </div>
          <button type="button" className="resident-request-detail-close" aria-label="Close request details" onClick={onClose}>×</button>
        </header>
        <div className="resident-request-detail-dialog-content">
          <ResidentRequestDetailContent request={request} relatedRequests={relatedRequests} customTemplates={customTemplates} />
          {request.status === 'Returned for edits' && <ResidentCorrectionResubmission request={request} onSubmit={onSubmitCorrection} customTemplates={customTemplates} />}
        </div>
      </article>
    </div>,
    document.body,
  )
}

const loadCommunityUpdates = () => {
  try {
    const savedUpdates = window.localStorage.getItem(communityUpdatesStorageKey)
    if (!savedUpdates) return initialCommunityUpdates
    const parsedUpdates = JSON.parse(savedUpdates)
    if (!Array.isArray(parsedUpdates)) throw new Error('Saved community updates must be a list.')
    return parsedUpdates
  } catch (error) {
    console.error('Unable to load community updates from browser storage.', error)
    return initialCommunityUpdates
  }
}

const getUpdateDateParts = (date) => {
  const parsedDate = new Date(`${date}T00:00:00`)
  if (Number.isNaN(parsedDate.getTime())) return { day: '', month: '' }
  return {
    day: parsedDate.toLocaleDateString('en-US', { day: '2-digit' }),
    month: parsedDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase(),
  }
}

const formatCommunityTime = (time) => {
  if (!/^\d{2}:\d{2}$/.test(time || '')) return time
  const [hours, minutes] = time.split(':').map(Number)
  const period = hours >= 12 ? 'PM' : 'AM'
  const displayHour = hours % 12 || 12
  return `${displayHour}:${String(minutes).padStart(2, '0')} ${period}`
}

const CommunityUpdateContent = ({ update, className = '' }) => {
  const [imageOpen, setImageOpen] = useState(false)
  const hasStructuredDetails = update.location || update.startTime || update.endTime || update.time || update.description
  const legacyDetail = !hasStructuredDetails ? update.detail : ''
  const timeRange = update.startTime || update.endTime
    ? [update.startTime, update.endTime].filter(Boolean).map(formatCommunityTime).join(' – ')
    : update.time
  useEffect(() => {
    if (!imageOpen) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setImageOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [imageOpen])
  return (
    <div className={`community-update-content ${className}`}>
      {update.location && <small><strong>Location:</strong> {update.location}</small>}
      {timeRange && <small><strong>Time:</strong> {timeRange}</small>}
      {update.description && <small>{update.description}</small>}
      {legacyDetail && <small>{legacyDetail}</small>}
      {update.image?.dataUrl && <>
        <button type="button" className="community-update-image-button" onClick={() => setImageOpen(true)} aria-label={`View image for ${update.title}`}>
          <img className="community-update-image" src={update.image.dataUrl} alt={`${update.type === 'event' ? 'Event' : 'Announcement'}: ${update.title}`} loading="lazy" />
          <span>View image</span>
        </button>
        {imageOpen && createPortal(
          <div className="community-image-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageOpen(false) }}>
            <section className="community-image-viewer" role="dialog" aria-modal="true" aria-label={`Image for ${update.title}`}>
              <div className="community-image-viewer-heading">
                <strong>{update.title}</strong>
                <button type="button" aria-label="Close image viewer" onClick={() => setImageOpen(false)}>×</button>
              </div>
              <img src={update.image.dataUrl} alt={`${update.type === 'event' ? 'Event' : 'Announcement'}: ${update.title}`} />
              {update.image.fileName && <small>{update.image.fileName}</small>}
            </section>
          </div>,
          document.body,
        )}
      </>}
    </div>
  )
}

const getCommunityDateKey = (year, month, day) => `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

const ResidentLiveOfficeSchedule = ({ schedule, todayDateKey }) => {
  const today = new Date()
  const todayDay = today.getDay()
  const hasTodayOverride = schedule?.todayOverrideDate === todayDateKey && typeof schedule?.isOpenToday === 'boolean'
  const regularDays = Array.isArray(schedule?.days) ? schedule.days : []
  const isOpenToday = hasTodayOverride ? schedule.isOpenToday : regularDays.includes(todayDay)
  const statusLabel = isOpenToday ? 'Open today' : 'Closed today'

  return (
    <article className="office-availability-card resident-live-office-schedule" aria-label="Live barangay office schedule">
      <div className="office-availability-heading">
        <span className="office-availability-icon" aria-hidden="true">⌂</span>
        <div><span className="office-availability-eyebrow">LIVE OFFICE SCHEDULE</span><h3>Barangay office</h3><p>Service hours follow the Barangay Secretary’s schedule.</p></div>
        <span className={`office-availability-status ${isOpenToday ? 'is-scheduled' : ''}`} aria-live="polite">{statusLabel}</span>
      </div>
      <div className="office-availability-details">
        <div><span>Service hours</span><strong>{schedule?.hours || 'Not set'}</strong></div>
        <div className="office-days-schedule">
          <span>Regular office days</span>
          <div className="office-day-chips" aria-label="Weekly office schedule">
            {weekDaysMondayFirst.map(({ label, day }) => <span className={`office-day-chip${regularDays.includes(day) ? ' is-regular-day' : ''}${day === todayDay ? ' is-today' : ''}`} aria-current={day === todayDay ? 'date' : undefined} key={day}>{label}{day === todayDay && <small>Today</small>}</span>)}
          </div>
        </div>
      </div>
    </article>
  )
}

const CommunityUpdatesCalendar = ({ updates, isUpdateUnread, onViewUpdate }) => {
  const [visibleMonth, setVisibleMonth] = useState(() => {
    const today = new Date()
    return new Date(today.getFullYear(), today.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState('')
  const year = visibleMonth.getFullYear()
  const month = visibleMonth.getMonth()
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const calendarCells = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, index) => index + 1),
  ]
  const today = new Date()
  const todayKey = getCommunityDateKey(today.getFullYear(), today.getMonth(), today.getDate())
  const updatesByDate = new Map()
  updates.forEach((update) => {
    if (!update.date) return
    updatesByDate.set(update.date, [...(updatesByDate.get(update.date) || []), update])
  })
  const selectedDateUpdates = updatesByDate.get(selectedDate) || []
  const sortedUpdates = updates.slice().sort((first, second) => first.date.localeCompare(second.date))

  useEffect(() => {
    if (!selectedDate) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSelectedDate('')
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedDate])

  return (
    <section className="community-calendar-layout" aria-label="Announcements and events calendar">
      <div className="community-calendar-panel">
        <div className="community-calendar-heading">
          <div>
            <span className="section-number">COMMUNITY CALENDAR</span>
            <h2>{visibleMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</h2>
          </div>
          <div className="community-calendar-navigation">
            <button type="button" aria-label="Previous month" onClick={() => setVisibleMonth(new Date(year, month - 1, 1))}>‹</button>
            <button type="button" aria-label="Next month" onClick={() => setVisibleMonth(new Date(year, month + 1, 1))}>›</button>
          </div>
        </div>
        <div className="community-calendar-weekdays" aria-hidden="true">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => <span key={day}>{day}</span>)}
        </div>
        <div className="community-calendar-days">
          {calendarCells.map((day, index) => {
            if (!day) return <span className="community-calendar-empty" key={`empty-${index}`} aria-hidden="true" />
            const dateKey = getCommunityDateKey(year, month, day)
            const dayUpdates = updatesByDate.get(dateKey) || []
            return (
              <button
                type="button"
                className={`${dateKey === todayKey ? 'is-today' : ''} ${dayUpdates.length ? 'has-updates' : ''}`}
                key={dateKey}
                onClick={() => {
                  dayUpdates.forEach((update) => onViewUpdate?.(update))
                  setSelectedDate(dateKey)
                }}
                aria-label={`${visibleMonth.toLocaleDateString('en-US', { month: 'long' })} ${day}${dayUpdates.length ? `, ${dayUpdates.length} update${dayUpdates.length === 1 ? '' : 's'}` : ', no updates'}`}
              >
                <span>{day}</span>
                {dayUpdates.length > 0 && <span className="community-calendar-day-count">{dayUpdates.length}</span>}
                {dayUpdates.some((update) => isUpdateUnread?.(update)) && <span className="community-calendar-unread-dot" role="img" aria-label="New update" title="New update" />}
              </button>
            )
          })}
        </div>
        <p className="community-calendar-hint">Select a day to view its announcements and events.</p>
      </div>
      <aside className="community-calendar-list" aria-label="All announcements and events">
        <div className="community-calendar-list-heading">
          <span className="section-number">ALL UPDATES</span>
          <strong>{sortedUpdates.length} announcement{sortedUpdates.length === 1 ? '' : 's'} &amp; events</strong>
        </div>
        {sortedUpdates.length ? (
          <div className="community-calendar-list-items">
            {sortedUpdates.map((update) => {
              const dateParts = getUpdateDateParts(update.date)
              const timeLabel = update.startTime || update.endTime
                ? [update.startTime, update.endTime].filter(Boolean).map(formatCommunityTime).join(' – ')
                : update.time ? formatCommunityTime(update.time) : ''
              return (
                <button type="button" className="community-calendar-list-item" key={update.id} onClick={() => {
                  (updatesByDate.get(update.date) || [update]).forEach((dateUpdate) => onViewUpdate?.(dateUpdate))
                  setSelectedDate(update.date)
                }}>
                  <span className="community-calendar-list-date"><strong>{dateParts.day}</strong><small>{dateParts.month}</small></span>
                  <span className="community-calendar-list-copy">
                    <small className="update-type-label">{update.type === 'event' ? 'Event' : 'Announcement'}</small>
                    <strong>{update.title}</strong>
                    {isUpdateUnread?.(update) && <span className="resident-request-new-dot" role="img" aria-label="New update" title="New update" />}
                    {timeLabel && <small className="community-calendar-list-time">{timeLabel}</small>}
                    {update.location && <small>{update.location}</small>}
                  </span>
                  <span className="community-calendar-list-arrow" aria-hidden="true">›</span>
                </button>
              )
            })}
          </div>
        ) : <p className="empty-updates">No announcements or events have been posted.</p>}
      </aside>
      {selectedDate && createPortal(
        <div className="community-calendar-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedDate('') }}>
          <section className="community-calendar-modal" role="dialog" aria-modal="true" aria-labelledby="community-calendar-modal-title">
            <div className="community-calendar-modal-heading">
              <div>
                <span className="section-number">DAILY SCHEDULE</span>
                <h2 id="community-calendar-modal-title">{new Date(`${selectedDate}T00:00:00`).toLocaleDateString('en-US', { dateStyle: 'full' })}</h2>
              </div>
              <button type="button" aria-label="Close daily schedule" onClick={() => setSelectedDate('')}>×</button>
            </div>
            {selectedDateUpdates.length ? (
              <div className="community-calendar-modal-list">
                {selectedDateUpdates.map((update) => (
                  <article className="community-calendar-modal-update" key={update.id}>
                    <span className="update-type-label">{update.type === 'event' ? 'Event' : 'Announcement'}</span>
                    <h3>{update.title}</h3>
                    <CommunityUpdateContent update={update} />
                  </article>
                ))}
              </div>
            ) : <p className="community-calendar-no-updates">No announcements or events are scheduled for this day.</p>}
          </section>
        </div>,
        document.body,
      )}
    </section>
  )
}

function ResidentPhotoGallery({ documentName, photos }) {
  const [activePhotoIndex, setActivePhotoIndex] = useState(null)
  const activePhoto = Number.isInteger(activePhotoIndex) ? photos[activePhotoIndex] : null

  useEffect(() => {
    if (!activePhoto) return undefined
    const handleViewerKeys = (event) => {
      if (event.key === 'Escape') setActivePhotoIndex(null)
      if (event.key === 'ArrowLeft' && photos.length > 1) {
        setActivePhotoIndex((index) => (index - 1 + photos.length) % photos.length)
      }
      if (event.key === 'ArrowRight' && photos.length > 1) {
        setActivePhotoIndex((index) => (index + 1) % photos.length)
      }
    }
    window.addEventListener('keydown', handleViewerKeys)
    return () => window.removeEventListener('keydown', handleViewerKeys)
  }, [activePhoto, photos.length])

  const changePhoto = (offset) => {
    setActivePhotoIndex((index) => (index + offset + photos.length) % photos.length)
  }

  return (
    <>
      <div className="resident-photo-review">
        {photos.map((photo, index) => (
          <figure key={photo.key}>
            <button
              type="button"
              className="resident-photo-review-view-button"
              onClick={() => setActivePhotoIndex(index)}
              aria-label={`View ${photo.label} photo for ${documentName}`}
            >
              <img src={photo.dataUrl} alt={`${photo.label} photo for ${documentName}`} />
              {photo.key.endsWith('__philsys-verification') && <span className="resident-photo-proof-mark" aria-hidden="true">✓ PhilSys proof</span>}
            </button>
            <figcaption><strong className="resident-photo-title">{photo.label}</strong><small>{photo.fileName}</small></figcaption>
          </figure>
        ))}
        {!photos.length && <p className="evidence-empty">No uploaded images for this document yet.</p>}
      </div>
      {activePhoto && createPortal(
        <div className="community-image-viewer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setActivePhotoIndex(null) }}>
          <section className="community-image-viewer resident-photo-viewer" role="dialog" aria-modal="true" aria-label={`${activePhoto.label} photo for ${documentName}`}>
            <div className="community-image-viewer-heading">
              <strong>{activePhoto.label} · {documentName}</strong>
              <button type="button" aria-label="Close photo viewer" autoFocus onClick={() => setActivePhotoIndex(null)}>×</button>
            </div>
            <img src={activePhoto.dataUrl} alt={`${activePhoto.label} photo for ${documentName}`} />
            {activePhoto.fileName && <small>{activePhoto.fileName}</small>}
            {photos.length > 1 && <div className="resident-photo-viewer-controls">
              <button type="button" onClick={() => changePhoto(-1)}>Previous photo</button>
              <span>{activePhotoIndex + 1} of {photos.length}</span>
              <button type="button" onClick={() => changePhoto(1)}>Next photo</button>
            </div>}
          </section>
        </div>,
        document.body,
      )}
    </>
  )
}

function RequirementPhotoUpload({ requirement, selectedDocuments, currentRequestDocument, requirementPhotos, requirementPhotoLoading, updateRequirementPhoto, customTemplates = [] }) {
  const requirementKey = requirement.replace(/\W+/g, '-').toLowerCase()
  const isId = requirement === 'Valid government ID'
  const photoSlots = isId ? ['front', 'back'] : ['photo']
  const requiredByDocuments = selectedDocuments.filter((document) => (
    getDocumentRequirements(document, customTemplates).includes(requirement)
  ))

  return (
    <div className="photo-upload-group">
      <strong>
        <span className="photo-requirement-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.5" /></svg></span>
        <span className="photo-upload-requirement-name">{requirement}</span>
        {selectedDocuments.length > 1 && <small className="photo-requirement-scope">{requiredByDocuments.length > 1 ? `Shared by ${requiredByDocuments.length} documents` : `For ${requiredByDocuments[0] || currentRequestDocument}`}</small>}
      </strong>
      <div className={`photo-upload-slots${photoSlots.length === 1 ? ' single-photo' : ''}`}>
        {photoSlots.map((side) => {
          const photoKey = `${requirementKey}-${side}`
          const storedPhotoKey = getRequirementPhotoStorageKey(currentRequestDocument, photoKey, selectedDocuments)
          const uploadedPhoto = getAvailableRequirementPhoto(requirementPhotos, currentRequestDocument, photoKey, selectedDocuments)
          return (
            <label className="photo-upload" key={photoKey}>
              <span className="photo-upload-label"><span className="photo-upload-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 16V4M7 9l5-5 5 5M4 15v5h16v-5" /></svg></span><span>{isId ? `ID ${side}` : 'Paper photo'}</span></span>
              <input type="file" accept="image/*" capture="environment" onChange={(event) => updateRequirementPhoto(photoKey, event.target.files[0])} required={!uploadedPhoto} />
              {requirementPhotoLoading[storedPhotoKey] ? <small>Preparing image…</small> : uploadedPhoto && <small>{uploadedPhoto.fileName}</small>}
            </label>
          )
        })}
      </div>
    </div>
  )
}

function GcashTransferInstructions({ amount, recipients }) {
  const [qrRecipient, setQrRecipient] = useState(null)

  return (
    <section className="resident-gcash-transfer-details" aria-label="GCash transfer details">
      <div><strong>Send with GCash</strong><span>Send the exact selected total of ₱{Number(amount || 0).toFixed(2)} and verify the recipient name in GCash before confirming.</span></div>
      {recipients.length > 0 && <TableSearch label="GCash recipients"><div className="resident-gcash-recipient-table-wrap">
        <table className="resident-gcash-recipient-table">
          <thead><tr><th scope="col">Name</th><th scope="col">GCash number</th><th scope="col">QR</th></tr></thead>
          <tbody>{recipients.map((recipient) => (
            <tr key={recipient.id}>
              <th scope="row">{recipient.displayName || 'Name not set'}</th>
              <td>{recipient.mobileNumber || 'Number not set'}</td>
              <td>{recipient.qrImage?.dataUrl
                ? <button
                  type="button"
                  className="resident-gcash-qr-button"
                  aria-label={`View GCash QR for ${recipient.displayName}`}
                  onClick={() => setQrRecipient(recipient)}
                >
                  <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h3v3h-3zM19 14v2M14 19h2M19 19h2v2h-2M19 17h2" /></svg>
                  <span>View QR</span>
                </button>
                : <span className="resident-gcash-no-qr">Not available</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div></TableSearch>}
      {!recipients.length && <p>GCash payment details are not configured. Please contact the Barangay Hall before sending payment.</p>}
      <p>Open GCash directly on your phone, then verify the recipient and amount before sending. Never share your PIN or OTP. Return here afterward to submit the receipt or reference number.</p>
      {qrRecipient?.qrImage?.dataUrl && <div className="resident-gcash-qr-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) setQrRecipient(null)
      }}>
        <section className="resident-gcash-qr-dialog" role="dialog" aria-modal="true" aria-labelledby="resident-gcash-qr-title" onKeyDown={(event) => {
          if (event.key === 'Escape') setQrRecipient(null)
        }}>
          <header>
            <div><span className="section-number">GCASH RECIPIENT</span><h3 id="resident-gcash-qr-title">{qrRecipient.displayName}</h3><p>{qrRecipient.mobileNumber}</p></div>
            <button type="button" aria-label="Close GCash QR" autoFocus onClick={() => setQrRecipient(null)}>×</button>
          </header>
          <img src={qrRecipient.qrImage.dataUrl} alt={`GCash QR code for ${qrRecipient.displayName}`} />
        </section>
      </div>}
    </section>
  )
}

function TableSearch({ label, children }) {
  const tableRegionRef = useRef(null)
  const searchStatusRef = useRef(null)
  const emptyStateRef = useRef(null)
  const [query, setQuery] = useState('')
  const normalizedQuery = query.trim().toLocaleLowerCase()

  useEffect(() => {
    const table = tableRegionRef.current?.querySelector('table')
    const rows = Array.from(table?.tBodies[0]?.rows || [])
    let visibleRows = 0

    rows.forEach((row) => {
      if (row.classList.contains('registration-detail-row')) {
        row.hidden = normalizedQuery.length > 0 && Boolean(row.previousElementSibling?.hidden)
        return
      }

      const emptyStateRow = row.children.length === 1
        && row.firstElementChild?.matches('td[colspan]')
      const matches = !normalizedQuery
        || (!emptyStateRow && row.textContent.toLocaleLowerCase().includes(normalizedQuery))
      row.hidden = !matches
      if (matches && !emptyStateRow) visibleRows += 1
    })

    if (searchStatusRef.current) {
      searchStatusRef.current.textContent = `${visibleRows} results`
    }
    if (emptyStateRef.current) {
      emptyStateRef.current.hidden = !normalizedQuery || visibleRows > 0
    }
  }, [children, normalizedQuery])

  return (
    <div className="table-search-group">
      <div className="table-search-toolbar">
        <input
          type="search"
          aria-label={`Search ${label}`}
          placeholder={`Search ${label}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {normalizedQuery && <span ref={searchStatusRef} className="table-search-count" aria-live="polite" />}
      </div>
      <div className="table-search-content" ref={tableRegionRef}>{children}</div>
      {normalizedQuery && <p ref={emptyStateRef} className="table-search-empty" role="status" hidden>No {label} match this search.</p>}
    </div>
  )
}

function PaymentWorkflowTabs({ activeView, onSelect }) {
  return (
    <div className="payment-workflow-tabs" role="group" aria-label="Payment workflow">
      <button type="button" className={activeView === 'payments' ? 'active' : ''} aria-pressed={activeView === 'payments'} onClick={() => onSelect('payments')}>Payment tracking</button>
      <button type="button" className={activeView === 'refunds' ? 'active' : ''} aria-pressed={activeView === 'refunds'} onClick={() => onSelect('refunds')}>Cancellations &amp; refunds</button>
    </div>
  )
}

function App() {
  const welcomePageRef = useRef(null)
  const adminContentRef = useRef(null)
  const skipNextDatabaseSaveRef = useRef(false)
  const databaseSaveQueueRef = useRef(Promise.resolve())
  const databaseRecordsRef = useRef(null)
  const publicCommunityEtagRef = useRef('')
  const databaseEtagRef = useRef('')
  const [selectedRole, setSelectedRole] = useState('')
  const [hasStarted, setHasStarted] = useState(false)
  const [showOfficials, setShowOfficials] = useState(false)
  const [showResidentCheck, setShowResidentCheck] = useState(false)
  const [showResidentOptions, setShowResidentOptions] = useState(false)
  const [showResidentInboxPage, setShowResidentInboxPage] = useState(false)
  const [selectedInboxRequestId, setSelectedInboxRequestId] = useState(null)
  const [residentCancellationRequestId, setResidentCancellationRequestId] = useState('')
  const [cancellationGcashNumber, setCancellationGcashNumber] = useState('')
  const [cancellationGcashError, setCancellationGcashError] = useState('')
  const [residentDashboardSection, setResidentDashboardSection] = useState('community')
  const [residentMobileMenuOpen, setResidentMobileMenuOpen] = useState(false)
  const [residentCommunityTab, setResidentCommunityTab] = useState('announcements')
  const [residentDraftsCorrectionsTab, setResidentDraftsCorrectionsTab] = useState('drafts')
  const [residentDocumentGuideOpen, setResidentDocumentGuideOpen] = useState(false)
  const [residentDocumentGuideReviewed, setResidentDocumentGuideReviewed] = useState(false)
  const [selectedResidentHistoryRequestId, setSelectedResidentHistoryRequestId] = useState(null)
  const [returnToResidentDashboardAfterRequest, setReturnToResidentDashboardAfterRequest] = useState(false)
  const [residentDrafts, setResidentDrafts] = useState(() => readStoredList(residentDraftsStorageKey, []))
  const [residentDraftError, setResidentDraftError] = useState('')
  const activeResidentDraftIdRef = useRef(null)
  const residentDraftsRef = useRef(residentDrafts)
  const residentLocalCacheSaveQueueRef = useRef(Promise.resolve())
  const skipResidentLocalCacheSaveRef = useRef(new Map())
  useEffect(() => {
    residentDraftsRef.current = residentDrafts
  }, [residentDrafts])
  const saveResidentLocalRecord = (key, value) => {
    const save = residentLocalCacheSaveQueueRef.current
      .catch(() => {})
      .then(() => saveLocalResidentRecord(key, value))
    residentLocalCacheSaveQueueRef.current = save.catch(() => {})
    return save
  }
  const shouldSkipResidentLocalCacheSave = (key, value) => {
    if (!skipResidentLocalCacheSaveRef.current.has(key)) return false
    const syncedValue = skipResidentLocalCacheSaveRef.current.get(key)
    skipResidentLocalCacheSaveRef.current.delete(key)
    return syncedValue === value
  }
  useEffect(() => {
    if (!showResidentCheck || !returnToResidentDashboardAfterRequest) return undefined

    const makeCurrentDraftResumable = () => {
      const activeDraftId = activeResidentDraftIdRef.current
      if (!activeDraftId) return
      try {
        const updatedDrafts = residentDraftsRef.current.map((draft) => draft.id === activeDraftId
          ? { ...draft, status: 'saved', updatedAt: new Date().toISOString() }
          : draft)
        if (residentDraftsRef.current.some((draft) => draft.id === activeDraftId)) {
          setResidentDrafts(updatedDrafts)
          saveResidentLocalRecord(residentDraftsStorageKey, updatedDrafts)
            .then(() => setResidentDraftError(''))
            .catch((error) => {
              console.error('Unable to preserve the resident request draft.', error)
              setResidentDraftError('Your request could not be preserved. Check available browser storage before leaving this page.')
            })
        }
      } catch (error) {
        console.error('Unable to preserve the resident request draft.', error)
        setResidentDraftError('Your request could not be preserved. Check available browser storage before leaving this page.')
      }
    }

    window.addEventListener('offline', makeCurrentDraftResumable)
    window.addEventListener('pagehide', makeCurrentDraftResumable)
    if (!window.navigator.onLine) makeCurrentDraftResumable()
    return () => {
      window.removeEventListener('offline', makeCurrentDraftResumable)
      window.removeEventListener('pagehide', makeCurrentDraftResumable)
    }
  }, [showResidentCheck, returnToResidentDashboardAfterRequest])
  const [inboxAccessMode, setInboxAccessMode] = useState(false)
  const [showRegistrationForm, setShowRegistrationForm] = useState(false)
  const [registrationWalkInGuideOpen, setRegistrationWalkInGuideOpen] = useState(false)
  const registrationWalkInGuideTriggerRef = useRef(null)
  const [registrationSubmitted, setRegistrationSubmitted] = useState(false)
  const [registrationReferenceDialogOpen, setRegistrationReferenceDialogOpen] = useState(false)
  const [editingRegistrationId, setEditingRegistrationId] = useState('')
  const [returnToRegistrationCommunity, setReturnToRegistrationCommunity] = useState(false)
  const [submittedRegistrationId, setSubmittedRegistrationId] = useState('')
  const [registrationSubmitError, setRegistrationSubmitError] = useState('')
  const [registrationStorageWarning, setRegistrationStorageWarning] = useState('')
  const [isSubmittingRegistration, setIsSubmittingRegistration] = useState(false)
  const [recoveryPanelOpen, setRecoveryPanelOpen] = useState(false)
  const [recoveryForm, setRecoveryForm] = useState({ fullName: '', birthDate: '', contactInfo: '', address: '', reason: '' })
  const [recoveryFormError, setRecoveryFormError] = useState('')
  const [recoveryFormStatus, setRecoveryFormStatus] = useState('')
  const [recoverySubmittedId, setRecoverySubmittedId] = useState('')
  const [recoveryFormEditingRequestId, setRecoveryFormEditingRequestId] = useState('')
  const [recoverySubmissionMessage, setRecoverySubmissionMessage] = useState('')
  const [recoveryLookup, setRecoveryLookup] = useState({ reference: '', fullName: '' })
  const [recoveryLookupResult, setRecoveryLookupResult] = useState(null)
  const [recoveryTrackingOpen, setRecoveryTrackingOpen] = useState(false)
  const [recoveryTrackingEditOpen, setRecoveryTrackingEditOpen] = useState(false)
  const [recoveryTrackingEditForm, setRecoveryTrackingEditForm] = useState({ fullName: '', birthDate: '', contactInfo: '', address: '', reason: '' })
  const [recoveryTrackingEditError, setRecoveryTrackingEditError] = useState('')
  const [registrationData, setRegistrationData] = useState({
    firstName: '', middleName: '', lastName: '', suffix: '', birthDate: '', placeOfBirth: '', sex: '', civilStatus: '', nationality: 'Filipino',
    mobileNumber: '', emailAddress: '', ...registrationAddressDefaults, streetPurok: '', stayDuration: '',
    newResident: 'yes', previousAddress: '', previousBarangay: '', previousMunicipalityCity: '', dateOfTransfer: '', reasonForMoving: '',
    householdHead: 'yes', householdHeadName: '', householdMembers: '1', relationshipToHead: '', validIdType: '', idNumber: '', proofOfResidence: '',
  })
  const [registrationFiles, setRegistrationFiles] = useState({ validId: null, proofOfResidence: null })
  const [residentName, setResidentName] = useState({ firstName: '', middleName: '', lastName: '', suffix: '', code: '' })
  const [residentToken, setResidentToken] = useState('')
  const [, setAuthenticatedResidentProfile] = useState(null)
  const [selectedDocuments, setSelectedDocuments] = useState([])
  const [residentStatus, setResidentStatus] = useState('')
  const [residentLoginError, setResidentLoginError] = useState('')
  const [registrationReferenceNotice, setRegistrationReferenceNotice] = useState(null)
  const [registrationCommunityOnlyAccess, setRegistrationCommunityOnlyAccess] = useState(false)
  const [showDocumentOptions, setShowDocumentOptions] = useState(false)
  const [showRequestForm, setShowRequestForm] = useState(false)
  const [showOfficialLogin, setShowOfficialLogin] = useState(false)
  const [showOfficialDashboard, setShowOfficialDashboard] = useState(false)
  const [isStorageLoaded, setIsStorageLoaded] = useState(false)
  const [isDatabaseConnected, setIsDatabaseConnected] = useState(false)
  const [isPublicCommunityConnected, setIsPublicCommunityConnected] = useState(false)
  const [isResidentDatabaseConnected, setIsResidentDatabaseConnected] = useState(false)
  const [residentDatabaseSyncError, setResidentDatabaseSyncError] = useState('')
  const [databaseSaveStatus, setDatabaseSaveStatus] = useState('checking')
  const [databaseSaveError, setDatabaseSaveError] = useState('')
  const [databaseLoadVersion, setDatabaseLoadVersion] = useState(0)
  const [residentRequests, setResidentRequests] = useState(() => {
    const storedRequests = loadResidentRequests()
    const storedHistory = readStoredList(residentHistoryStorageKey, [])
    return restoreUnprintedApprovedRequests(storedRequests, storedHistory).requests
  })
  const [residentNotificationReadState, setResidentNotificationReadState] = useState(readStoredResidentNotificationReadState)
  const [adminNavigationReadState, setAdminNavigationReadState] = useState(readStoredAdminNavigationReadState)
  const [documentWorkflowViewedState, setDocumentWorkflowViewedState] = useState(loadDocumentWorkflowViewedState)
  const documentWorkflowViewedStateRef = useRef(documentWorkflowViewedState)
  const residentDashboardContentRef = useRef(null)
  const [residentPaymentDrafts, setResidentPaymentDrafts] = useState(() => readStoredList(residentPaymentDraftsStorageKey, []))
  const residentPaymentDraftsRef = useRef(residentPaymentDrafts)
  useEffect(() => {
    residentPaymentDraftsRef.current = residentPaymentDrafts
  }, [residentPaymentDrafts])
  const [adminResidents, setAdminResidents] = useState(() => readStoredList(residentRecordsStorageKey, initialResidentRecords))
  const [residentCodeRecoveryRequests, setResidentCodeRecoveryRequests] = useState(() => readStoredList(residentCodeRecoveryRequestsStorageKey, []))
  const [residentProfileUpdateRequests, setResidentProfileUpdateRequests] = useState(() => readStoredList(residentProfileUpdateRequestsStorageKey, []))
  const [documentFees, setDocumentFees] = useState(() => {
    try {
      const saved = window.localStorage.getItem(documentFeesStorageKey)
      const parsed = saved ? JSON.parse(saved) : {}
      const savedVersion = Number(window.localStorage.getItem(documentFeesDefaultsVersionStorageKey) || 0)
      const localTemplates = readStoredList(certificateTemplatesStorageKey, [])
      return migrateDocumentFees(parsed, savedVersion, [
        ...barangayDocuments,
        ...localTemplates.map((template) => template.name),
      ])
    } catch (error) {
      console.error('Unable to load document fees from browser storage.', error)
      return initialDocumentFees
    }
  })
  const [officialProfiles, setOfficialProfiles] = useState(() => readStoredList(officialProfilesStorageKey, initialOfficialProfiles))
  const [residentHistory, setResidentHistory] = useState(() => {
    const storedHistory = readStoredList(residentHistoryStorageKey, [])
    return restoreUnprintedApprovedRequests(loadResidentRequests(), storedHistory).history
  })
  const residentRequestsRef = useRef(residentRequests)
  const residentHistoryRef = useRef(residentHistory)
  const residentRequestSyncSnapshotRef = useRef(new Map())
  const residentRequestSaveQueueRef = useRef(Promise.resolve())
  const residentRequestSavePendingRef = useRef(0)
  const residentRequestSyncPauseUntilRef = useRef(0)
  const resetResidentSyncConnection = () => {
    residentRequestSyncSnapshotRef.current = new Map()
    setIsResidentDatabaseConnected(false)
    setResidentDatabaseSyncError('')
  }
  useEffect(() => {
    residentRequestsRef.current = residentRequests
  }, [residentRequests])
  useEffect(() => {
    residentHistoryRef.current = residentHistory
  }, [residentHistory])
  const [archivedResidents, setArchivedResidents] = useState(() => readStoredList(archivedResidentsStorageKey, []))
  const [issuedDocuments, setIssuedDocuments] = useState(() => readStoredList(issuedDocumentsStorageKey, []))
  const [customCertificateTemplates, setCustomCertificateTemplates] = useState(() => readStoredList(certificateTemplatesStorageKey, []))
  const [enabledCertificateTypes, setEnabledCertificateTypes] = useState(() => readStoredList(enabledCertificateTypesStorageKey, initialEnabledCertificateTypes))
  const certificateCatalogRef = useRef({ customCertificateTemplates, enabledCertificateTypes, documentFees })
  useEffect(() => {
    certificateCatalogRef.current = { customCertificateTemplates, enabledCertificateTypes, documentFees }
  }, [customCertificateTemplates, enabledCertificateTypes, documentFees])
  const [registrationRequests, setRegistrationRequests] = useState(() => readStoredList(registrationRequestsStorageKey, []))
  const [expandedRegistrationId, setExpandedRegistrationId] = useState(null)
  const [registrationReviewStage, setRegistrationReviewStage] = useState('details')
  const [registrationResidentViewCode, setRegistrationResidentViewCode] = useState('')
  const [registrationDecisionModalOpen, setRegistrationDecisionModalOpen] = useState(false)
  const [registrationQueueSearch, setRegistrationQueueSearch] = useState('')
  const [registrationSyncError, setRegistrationSyncError] = useState('')
  const [registrationActionError, setRegistrationActionError] = useState('')
  const [registrationAdminNote, setRegistrationAdminNote] = useState('')
  const [processingRegistrationId, setProcessingRegistrationId] = useState('')
  const [expandedRecoveryRequestId, setExpandedRecoveryRequestId] = useState(null)
  const [adminRecoveryMessage, setAdminRecoveryMessage] = useState('')
  const [recoveryDeliveryRequest, setRecoveryDeliveryRequest] = useState(null)
  const [recoveryDeliveryMode, setRecoveryDeliveryMode] = useState('send')
  const [isSendingRecoveryCode, setIsSendingRecoveryCode] = useState(false)
  const [isSendingRecoveryNotice, setIsSendingRecoveryNotice] = useState(false)
  const [officialBackendToken, setOfficialBackendToken] = useState('')
  const [adminView, setAdminView] = useState('overview')
  const allCertificateDocuments = [...new Set([...barangayDocuments, ...customCertificateTemplates.map((template) => template.name)])]
  const getCertificateTemplateTarget = (request) => {
    const targets = (request?.documents || []).filter((document) => (
      allCertificateDocuments.includes(document)
      && !request.printedDocuments?.[document]
    ))
    return targets.length === 1 ? targets[0] : null
  }
  useEffect(() => {
    if (adminView !== 'registrations' || !expandedRegistrationId) return undefined
    const previousBodyOverflow = document.body.style.overflow
    const previousBodyPaddingRight = document.body.style.paddingRight
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return
      setExpandedRegistrationId(null)
      setRegistrationReviewStage('')
      setRegistrationActionError('')
      setRegistrationDecisionModalOpen(false)
    }
    document.body.style.overflow = 'hidden'
    if (scrollbarWidth > 0) {
      const bodyPaddingRight = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0
      document.body.style.paddingRight = `${bodyPaddingRight + scrollbarWidth}px`
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.body.style.paddingRight = previousBodyPaddingRight
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [adminView, expandedRegistrationId])
  const [previewTemplateDocument, setPreviewTemplateDocument] = useState(null)
  const [processingTemplateDocument, setProcessingTemplateDocument] = useState(null)
  const [highlightedCertificateTemplate, setHighlightedCertificateTemplate] = useState(null)
  useEffect(() => {
    if (!showOfficialDashboard || adminView !== 'certificateTemplates') return undefined
    let isCancelled = false
    let idleHandle
    let timeoutHandle
    let index = 0
    const documents = [...new Set([...barangayDocuments, ...customCertificateTemplates.map((template) => template.name)])]
    const scheduleNext = () => {
      if (isCancelled || index >= documents.length) return
      if (typeof window.requestIdleCallback === 'function') {
        idleHandle = window.requestIdleCallback(preloadNext, { timeout: 1000 })
      } else {
        timeoutHandle = window.setTimeout(preloadNext, 0)
      }
    }
    const preloadNext = async () => {
      if (isCancelled || index >= documents.length) return
      const document = documents[index++]
      try {
        await preloadCertificateTemplatePreview(document, customCertificateTemplates)
      } catch (error) {
        console.error(`Unable to prepare the ${document} template preview.`, error)
      }
      scheduleNext()
    }
    scheduleNext()
    return () => {
      isCancelled = true
      if (idleHandle !== undefined && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(idleHandle)
      }
      if (timeoutHandle !== undefined) window.clearTimeout(timeoutHandle)
    }
  }, [adminView, customCertificateTemplates, showOfficialDashboard])
  const [isCustomTemplateFormOpen, setIsCustomTemplateFormOpen] = useState(false)
  const [isCustomTemplatePreviewOpen, setIsCustomTemplatePreviewOpen] = useState(false)
  const [customTemplateName, setCustomTemplateName] = useState('')
  const [editingCertificateTemplate, setEditingCertificateTemplate] = useState('')
  const [editingCustomTemplateId, setEditingCustomTemplateId] = useState('')
  const [customTemplateFile, setCustomTemplateFile] = useState(null)
  const [customTemplatePreserveHeader, setCustomTemplatePreserveHeader] = useState(false)
  const [isCertificateTemplateEditorOpen, setIsCertificateTemplateEditorOpen] = useState(false)
  const certificateTemplateUploadRef = useRef(null)
  const [customTemplateDetectedFields, setCustomTemplateDetectedFields] = useState([])
  const [customTemplateRequirements, setCustomTemplateRequirements] = useState('Valid government ID')
  const [customTemplateError, setCustomTemplateError] = useState('')
  const [customTemplateStatus, setCustomTemplateStatus] = useState('')
  const [isSavingCustomTemplate, setIsSavingCustomTemplate] = useState(false)
  const customTemplateFieldGroups = groupCertificateTemplateFields(customTemplateDetectedFields)
  const customTemplateFieldCounts = {
    blanks: customTemplateDetectedFields.filter((field) => field.type !== 'checkbox').length,
    checkboxOptions: customTemplateDetectedFields.filter((field) => field.type === 'checkbox').length,
    checkboxGroups: new Set(customTemplateDetectedFields
      .filter((field) => field.type === 'checkbox')
      .map((field) => field.groupId)).size,
    needsReview: customTemplateDetectedFields.filter((field) => field.needsReview).length,
  }
  useEffect(() => {
    if (!isCustomTemplateFormOpen) return undefined
    const frame = window.requestAnimationFrame(() => {
      certificateTemplateUploadRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      certificateTemplateUploadRef.current?.querySelector('input[type="text"]')?.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [isCustomTemplateFormOpen])
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth > 720)
  useEffect(() => {
    const mobileNavigationQuery = window.matchMedia('(max-width: 720px)')
    const updateSidebarForViewport = (event) => setSidebarOpen(!event.matches)
    if (mobileNavigationQuery.addEventListener) {
      mobileNavigationQuery.addEventListener('change', updateSidebarForViewport)
      return () => mobileNavigationQuery.removeEventListener('change', updateSidebarForViewport)
    }
    mobileNavigationQuery.addListener(updateSidebarForViewport)
    return () => mobileNavigationQuery.removeListener(updateSidebarForViewport)
  }, [])
  const [notificationsOpen, setNotificationsOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  const [darkMode, setDarkMode] = useState(() => loadAdminPreferences().darkMode)
  const [fontSize, setFontSize] = useState(() => loadAdminPreferences().fontSize)
  const [autoLogoutMinutes, setAutoLogoutMinutes] = useState(() => loadAdminPreferences().autoLogoutMinutes)
  const [adminInvitations, setAdminInvitations] = useState([])
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const [adminInvitationMessage, setAdminInvitationMessage] = useState('')
  const [adminInvitationError, setAdminInvitationError] = useState('')
  const [isLoadingAdminInvitations, setIsLoadingAdminInvitations] = useState(false)
  const [isSendingAdminInvitation, setIsSendingAdminInvitation] = useState(false)
  useEffect(() => {
    if (!isStorageLoaded || !showOfficialDashboard || adminView !== 'security' || !officialBackendToken) {
      return undefined
    }
    const controller = new AbortController()
    let requestPending = false
    const loadInvitations = async () => {
      if (document.visibilityState !== 'visible' || requestPending) return
      requestPending = true
      setIsLoadingAdminInvitations(true)
      try {
        const response = await fetchWithTimeout(`${BACKEND_API_URL}/admin-invitations.php`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${officialBackendToken}` },
          signal: controller.signal,
        })
        const result = await response.json()
        if (!response.ok || !result.success || !Array.isArray(result.data)) {
          throw new Error(result.message || 'Admin invitations could not be loaded.')
        }
        setAdminInvitations(result.data)
        setAdminInvitationError('')
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to load admin invitations.', error)
          setAdminInvitationError(error.message || 'Admin invitations could not be loaded.')
        }
      } finally {
        requestPending = false
        if (!controller.signal.aborted) setIsLoadingAdminInvitations(false)
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') loadInvitations()
    }
    loadInvitations()
    const refreshTimer = window.setInterval(loadInvitations, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', loadInvitations)
    window.addEventListener('online', loadInvitations)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', loadInvitations)
      window.removeEventListener('online', loadInvitations)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      controller.abort()
    }
  }, [adminView, isStorageLoaded, officialBackendToken, showOfficialDashboard])
  const [residentForm, setResidentForm] = useState({ firstName: '', middleName: '', lastName: '', suffix: '', address: '', birthDate: '', contactNumber: '', emailAddress: '', code: '' })
  const [residentFormOpen, setResidentFormOpen] = useState(false)
  const [editingResidentId, setEditingResidentId] = useState(null)
  const [residentFormError, setResidentFormError] = useState('')
  const [residentAccountMessage, setResidentAccountMessage] = useState('')
  const [passwordMessage, setPasswordMessage] = useState('')
  const [passwordFields, setPasswordFields] = useState({ current: '', next: '', confirm: '' })
  const [adminPassword, setAdminPassword] = useState(
    import.meta.env.DEV ? import.meta.env.VITE_ADMIN_PASSWORD || '' : '',
  )
  const [officialCredentials, setOfficialCredentials] = useState({ username: '', password: '' })
  const [loginStatus, setLoginStatus] = useState('')
  const [showReview, setShowReview] = useState(false)
  const [requestSubmitted, setRequestSubmitted] = useState(false)
  const [requestSubmittedHasPayment, setRequestSubmittedHasPayment] = useState(false)
  const [personalDetails, setPersonalDetails] = useState({ address: '', contactNumber: '', birthDate: '', purpose: '' })
  const [personalDetailsByDocument, setPersonalDetailsByDocument] = useState({})
  const [documentCopyCounts, setDocumentCopyCounts] = useState({})
  const [activeRequestDocument, setActiveRequestDocument] = useState('')
  const [requestDetailError, setRequestDetailError] = useState('')
  const [requirementPhotos, setRequirementPhotos] = useState({})
  const requirementPhotosRef = useRef(requirementPhotos)
  const replaceRequirementPhotos = (photos) => {
    requirementPhotosRef.current = photos
    setRequirementPhotos(photos)
  }
  const [requirementPhotoLoading, setRequirementPhotoLoading] = useState({})
  const [requirementPhotoError, setRequirementPhotoError] = useState('')
  const [selectedRequestId, setSelectedRequestId] = useState(null)
  const [selectedResidentGroupId, setSelectedResidentGroupId] = useState(null)
  const [documentQueueFilter, setDocumentQueueFilter] = useState('incoming')
  const [releaseForm, setReleaseForm] = useState({ requestId: '', releasedTo: '', orNumber: '', issuingOfficer: '' })
  const [releaseFormError, setReleaseFormError] = useState('')
  const [readyForm, setReadyForm] = useState({ requestId: '', pickupDate: '', pickupTime: '', pickupInstructions: '' })
  const [readyFormError, setReadyFormError] = useState('')
  const [isReviewingReadyForm, setIsReviewingReadyForm] = useState(false)
  const [selectedPaymentRequestIds, setSelectedPaymentRequestIds] = useState([])
  const [paymentBatchOpen, setPaymentBatchOpen] = useState(false)
  const [walkInPaymentNoticeOpen, setWalkInPaymentNoticeOpen] = useState(false)
  const [paymentProof, setPaymentProof] = useState(null)
  const [paymentProofOrNumber, setPaymentProofOrNumber] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [paymentProofError, setPaymentProofError] = useState('')
  const [paymentProofLoading, setPaymentProofLoading] = useState(false)
  const [paymentSaveConfirmation, setPaymentSaveConfirmation] = useState(null)
  const [gcashRecipients, setGcashRecipients] = useState(() => readStoredList(gcashRecipientsStorageKey, initialGcashRecipients))
  const [gcashRecipientEditor, setGcashRecipientEditor] = useState(null)
  const [gcashRecipientError, setGcashRecipientError] = useState('')
  const [gcashQrUploadLoading, setGcashQrUploadLoading] = useState(false)
  const gcashRecipientsRef = useRef(gcashRecipients)
  useEffect(() => {
    gcashRecipientsRef.current = gcashRecipients
  }, [gcashRecipients])
  const [paymentReviewRequestId, setPaymentReviewRequestId] = useState('')
  const [paymentOrNumber, setPaymentOrNumber] = useState('')
  const [refundRequestId, setRefundRequestId] = useState('')
  const [refundTransactionNumber, setRefundTransactionNumber] = useState('')
  const [refundDestinationNumber, setRefundDestinationNumber] = useState('')
  const [refundProof, setRefundProof] = useState(null)
  const [refundProofError, setRefundProofError] = useState('')
  const [refundProofLoading, setRefundProofLoading] = useState(false)
  const [refundNote, setRefundNote] = useState('')
  const [refundError, setRefundError] = useState('')
  const [profileUpdateForm, setProfileUpdateForm] = useState({ birthDate: '', contactNumber: '', emailAddress: '', address: '' })
  const [profileUpdateFormOpen, setProfileUpdateFormOpen] = useState(false)
  const [profileUpdateError, setProfileUpdateError] = useState('')
  const [residentProfileUpdateResidentCode, setResidentProfileUpdateResidentCode] = useState('')
  const [certificateProcessingRequestId, setCertificateProcessingRequestId] = useState(null)
  const [certificateProcessingRequestGroupIds, setCertificateProcessingRequestGroupIds] = useState([])
  const [certificateProcessingDocument, setCertificateProcessingDocument] = useState(null)
  const [certificateDownloadError, setCertificateDownloadError] = useState('')
  const [showDeclineForm, setShowDeclineForm] = useState(false)
  const [showReturnEditsForm, setShowReturnEditsForm] = useState(false)
  const [returnEditsNote, setReturnEditsNote] = useState('')
  const [declineReason, setDeclineReason] = useState('')
  const [invalidRequirements, setInvalidRequirements] = useState([])
  const [selectedVerificationPhoto, setSelectedVerificationPhoto] = useState(null)
  const [selectedFinishedCertificate, setSelectedFinishedCertificate] = useState(null)
  const [selectedHistoryRequestId, setSelectedHistoryRequestId] = useState(null)
  const [requestSearch, setRequestSearch] = useState('')
  const [requestDocumentFilter, setRequestDocumentFilter] = useState('all')
  const [historySearch, setHistorySearch] = useState('')
  const [historyStatusFilter, setHistoryStatusFilter] = useState('all')
  const [residentRecordsTab, setResidentRecordsTab] = useState('active')
  const [residentRecordsSearch, setResidentRecordsSearch] = useState('')
  const [highlightedResidentId, setHighlightedResidentId] = useState('')
  const [officialAvailability, setOfficialAvailability] = useState(() => readStoredList(officialAvailabilityStorageKey, initialAvailability))
  const [officialPhotos, setOfficialPhotos] = useState(() => readStoredImageMap(officialPhotosStorageKey))
  const [officialPhotoError, setOfficialPhotoError] = useState('')
  const [expandedOfficialIndex, setExpandedOfficialIndex] = useState(null)
  const [communityUpdates, setCommunityUpdates] = useState(loadCommunityUpdates)
  const communityRecordsRef = useRef({})
  useEffect(() => {
    communityRecordsRef.current = {
      [communityUpdatesStorageKey]: communityUpdates,
      [officialProfilesStorageKey]: officialProfiles,
      [officialAvailabilityStorageKey]: officialAvailability,
      [officialPhotosStorageKey]: officialPhotos,
    }
  }, [communityUpdates, officialProfiles, officialAvailability, officialPhotos])
  const [communityUpdateFormOpen, setCommunityUpdateFormOpen] = useState(false)
  const [communityUpdatesError, setCommunityUpdatesError] = useState('')
  const applySharedCommunityRecords = useCallback((data) => {
    let receivedRemoteChanges = false
    const refreshRecord = (key, setValue, isValid, label, normalize = (value) => value) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return
      const value = normalize(data[key])
      if (!isValid(value)) throw new Error(`Saved ${label} must use a valid format.`)
      const serializedValue = JSON.stringify(value)
      try {
        if (window.localStorage.getItem(key) !== serializedValue) {
          window.localStorage.setItem(key, serializedValue)
        }
      } catch (error) {
        console.error(`Unable to cache refreshed ${label} in browser storage.`, error)
      }
      if (JSON.stringify(communityRecordsRef.current[key]) !== serializedValue) {
        receivedRemoteChanges = true
        setValue(value)
      }
    }

    refreshRecord(communityUpdatesStorageKey, setCommunityUpdates, Array.isArray, 'community updates')
    refreshRecord(officialProfilesStorageKey, setOfficialProfiles, Array.isArray, 'official profiles')
    refreshRecord(officialAvailabilityStorageKey, setOfficialAvailability, Array.isArray, 'official schedules')
    refreshRecord(
      officialPhotosStorageKey,
      setOfficialPhotos,
      isOfficialPhotoMap,
      'official photos',
      normalizeOfficialPhotoMap,
    )
    if (receivedRemoteChanges && isDatabaseConnected) skipNextDatabaseSaveRef.current = true
    setCommunityUpdatesError('')
  }, [isDatabaseConnected])
  const applySharedGcashRecipients = useCallback((data) => {
    if (!Object.prototype.hasOwnProperty.call(data, gcashRecipientsStorageKey)) return
    const recipients = data[gcashRecipientsStorageKey]
    if (!isValidGcashRecipientList(recipients)) {
      throw new Error('Saved GCash recipients must be a list of named phone numbers.')
    }
    const serializedRecipients = JSON.stringify(recipients)
    if (JSON.stringify(gcashRecipientsRef.current) === serializedRecipients) return
    window.localStorage.setItem(gcashRecipientsStorageKey, serializedRecipients)
    if (isDatabaseConnected) skipNextDatabaseSaveRef.current = true
    gcashRecipientsRef.current = recipients
    setGcashRecipients(recipients)
  }, [isDatabaseConnected])
  const applySharedCertificateCatalog = useCallback((data) => {
    let receivedRemoteChanges = false
    const refreshRecord = (key, currentValue, setValue, isValid, label) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return
      const value = data[key]
      if (!isValid(value)) throw new Error(`Saved ${label} must use a valid format.`)
      const serializedValue = JSON.stringify(value)
      try {
        if (window.localStorage.getItem(key) !== serializedValue) {
          window.localStorage.setItem(key, serializedValue)
        }
      } catch (error) {
        console.error(`Unable to cache refreshed ${label} in browser storage.`, error)
      }
      if (JSON.stringify(currentValue) === serializedValue) return
      receivedRemoteChanges = true
      setValue(value)
    }
    const hasValidTemplateLocation = (field) => (
      field && typeof field.key === 'string'
      && typeof field.label === 'string'
      && Number.isInteger(field.paragraph)
      && Number.isInteger(field.textNodeIndex)
    )
    const isValidTemplates = (value) => Array.isArray(value)
      && value.every((template) => (
        template && typeof template.id === 'string'
        && typeof template.name === 'string'
        && typeof template.contentBase64 === 'string'
        && template.contentBase64.length <= 5000000
        && Array.isArray(template.fields)
        && template.fields.length > 0
        && template.fields.every((field) => (
          hasValidTemplateLocation(field)
          || (field && typeof field.key === 'string'
            && typeof field.label === 'string'
            && Array.isArray(field.targets)
            && field.targets.length > 0
            && field.targets.every(hasValidTemplateLocation))
        ))
        && Array.isArray(template.requirements)
        && template.requirements.every((requirement) => typeof requirement === 'string' && requirement.trim())
      ))
      && value.reduce((total, template) => total + template.contentBase64.length, 0) <= 5000000
    refreshRecord(
      certificateTemplatesStorageKey,
      certificateCatalogRef.current.customCertificateTemplates,
      setCustomCertificateTemplates,
      isValidTemplates,
      'certificate templates',
    )
    refreshRecord(
      enabledCertificateTypesStorageKey,
      certificateCatalogRef.current.enabledCertificateTypes,
      setEnabledCertificateTypes,
      (value) => Array.isArray(value) && value.every((document) => typeof document === 'string'),
      'enabled certificate types',
    )
    refreshRecord(
      documentFeesStorageKey,
      certificateCatalogRef.current.documentFees,
      setDocumentFees,
      (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every((fee) => Number.isFinite(Number(fee)) && Number(fee) >= 0)),
      'certificate document fees',
    )
    if (receivedRemoteChanges && isDatabaseConnected) skipNextDatabaseSaveRef.current = true
  }, [isDatabaseConnected])
  const applySharedAdminSearchRecords = useCallback((data) => {
    const currentDatabaseRecords = databaseRecordsRef.current
    if (!currentDatabaseRecords) return

    let nextDatabaseRecords = currentDatabaseRecords
    const refreshList = (key, currentValue, setValue, label, normalize = (value) => value, allowLocalMerge = false) => {
      if (!Object.prototype.hasOwnProperty.call(data, key)) return
      const remoteValue = data[key]
      if (!Array.isArray(remoteValue)) throw new Error(`Saved ${label} must be a list.`)

      const baseline = currentDatabaseRecords[key]
      if (!allowLocalMerge && JSON.stringify(currentValue) !== JSON.stringify(baseline)) return

      const nextValue = normalize(remoteValue)
      if (JSON.stringify(currentValue) !== JSON.stringify(nextValue)) setValue(nextValue)
      nextDatabaseRecords = { ...nextDatabaseRecords, [key]: nextValue }
    }

    refreshList(
      residentCodeRecoveryRequestsStorageKey,
      residentCodeRecoveryRequests,
      setResidentCodeRecoveryRequests,
      'resident code recovery requests',
    )
    refreshList(
      residentProfileUpdateRequestsStorageKey,
      residentProfileUpdateRequests,
      setResidentProfileUpdateRequests,
      'resident profile update requests',
    )
    refreshList(
      residentRecordsStorageKey,
      adminResidents,
      setAdminResidents,
      'resident records',
      (records) => {
        const recoveryRequests = Array.isArray(data[residentCodeRecoveryRequestsStorageKey])
          ? data[residentCodeRecoveryRequestsStorageKey]
          : residentCodeRecoveryRequests
        const reconciledResidents = reconcileResidentCodeRotationRecords(records, recoveryRequests)
        return deduplicateResidentRecordsByName(reconciledResidents).residents
      },
    )
    refreshList(
      registrationRequestsStorageKey,
      registrationRequests,
      setRegistrationRequests,
      'registration requests',
      (records) => mergeRegistrationRequestLists(records, registrationRequests),
      true,
    )
    refreshList(
      archivedResidentsStorageKey,
      archivedResidents,
      setArchivedResidents,
      'archived residents',
    )
    refreshList(
      issuedDocumentsStorageKey,
      issuedDocuments,
      setIssuedDocuments,
      'issued documents',
    )

    databaseRecordsRef.current = nextDatabaseRecords
  }, [
    adminResidents,
    archivedResidents,
    issuedDocuments,
    registrationRequests,
    residentCodeRecoveryRequests,
    residentProfileUpdateRequests,
  ])
  const [communityUpdateForm, setCommunityUpdateForm] = useState({ type: 'announcement', title: '', location: '', startTime: '', endTime: '', description: '', date: '' })
  const [communityUpdateTimeError, setCommunityUpdateTimeError] = useState('')
  const [communityUpdateImage, setCommunityUpdateImage] = useState(null)
  const [communityUpdateImageError, setCommunityUpdateImageError] = useState('')
  const communityUpdateImageInputRef = useRef(null)
  const [editingUpdateId, setEditingUpdateId] = useState(null)
  const [showPublicSidebar, setShowPublicSidebar] = useState(false)
  const [showAboutPage, setShowAboutPage] = useState(false)
  const [aboutFromDashboard, setAboutFromDashboard] = useState(false)
  const [aboutFromResidentDashboard, setAboutFromResidentDashboard] = useState(false)
  const [barangayContactInformation, setBarangayContactInformation] = useState(readStoredBarangayContactInformation)
  const [barangayContactInformationDraft, setBarangayContactInformationDraft] = useState(null)
  const [barangayContactInformationError, setBarangayContactInformationError] = useState('')
  const [barangayContactInformationStatus, setBarangayContactInformationStatus] = useState('')
  const [showResidentInbox, setShowResidentInbox] = useState(false)
  const fullName = `${residentName.firstName} ${residentName.middleName} ${residentName.lastName} ${residentName.suffix}`.replace(/\s+/g, ' ').trim()
  const currentResidentRecord = adminResidents.find((resident) => resident.code.toLowerCase() === residentName.code.trim().toLowerCase())
  const currentRequestDocument = selectedDocuments.includes(activeRequestDocument) ? activeRequestDocument : selectedDocuments[0] || ''
  const uniqueRequestCertificateFields = getCertificateTemplateFields(currentRequestDocument, customCertificateTemplates)
  const hasRequestPurposeField = hasPurposeCertificateField(uniqueRequestCertificateFields)
  const todayDate = new Date()
  const todayDateInput = `${todayDate.getFullYear()}-${String(todayDate.getMonth() + 1).padStart(2, '0')}-${String(todayDate.getDate()).padStart(2, '0')}`
  const getRequestCertificateValuesForDocument = (document) => {
    const details = personalDetailsByDocument[document] || personalDetails
    const categoryValues = Object.fromEntries(getCertificateTemplateFields(document, customCertificateTemplates)
      .map((field) => {
        const savedValue = getCertificateFieldValue(details, field)
        const value = savedValue
          || (field.key === 'issuePurpose' ? details.purpose : '')
          || (field.key === 'appearanceDate' ? details.dateOfAppearance || details.date_of_appearance : '')
        return [field.key, value ?? '']
      }))
    return {
      ...details,
      ...categoryValues,
      fullName: details.fullName || fullName,
      address: document === 'Barangay Clearance'
        ? normalizeBarangayZone(categoryValues.address || details.address || currentResidentRecord?.address)
        : details.address || currentResidentRecord?.address || '',
      businessAddress: details.businessAddress || details.address || currentResidentRecord?.address || '',
      appearanceAddress: document === 'Certificate of Appearance'
        ? normalizeBarangayZone(categoryValues.appearanceAddress || details.appearanceAddress || details.address || currentResidentRecord?.address)
        : details.appearanceAddress || details.address || currentResidentRecord?.address || '',
      municipality: document === 'Certificate of Appearance' ? 'Bongabong' : details.municipality || 'Bongabong',
      dateIssued: details.dateIssued || todayDateInput,
      age: details.age || ageFromBirthDate(details.birthDate || ''),
    }
  }
  const getDocumentCopyCount = (document) => {
    const copyCount = Number(documentCopyCounts[document] ?? 1)
    return Number.isSafeInteger(copyCount) && copyCount > 0 ? copyCount : null
  }
  const getDocumentFeeSubtotal = (document) => {
    const copyCount = getDocumentCopyCount(document)
    if (copyCount === null) return null
    const unitFeeCents = Math.round(Number(documentFees[document] || 0) * 100)
    const subtotalCents = unitFeeCents * copyCount
    return Number.isSafeInteger(unitFeeCents) && Number.isSafeInteger(subtotalCents)
      ? subtotalCents / 100
      : null
  }
  const getSelectedRequestFeeTotal = (documents = selectedDocuments) => {
    const subtotals = documents.map(getDocumentFeeSubtotal)
    if (subtotals.some((subtotal) => subtotal === null)) return null
    const totalCents = subtotals.reduce((total, subtotal) => total + Math.round(subtotal * 100), 0)
    return Number.isSafeInteger(totalCents) ? totalCents / 100 : null
  }
  const selectedRequestRequirements = selectedDocuments.length > 1
    ? getCombinedDocumentRequirements(selectedDocuments, customCertificateTemplates)
    : getDocumentRequirements(currentRequestDocument, customCertificateTemplates)
  const requestCertificateValues = getRequestCertificateValuesForDocument(currentRequestDocument)
  const normalizeResidentName = (name) => normalizeRecoveryIdentity(name)

  useEffect(() => {
    const active = showRequestForm || showReview
    document.documentElement.classList.toggle('request-workflow-scroll', active)
    return () => document.documentElement.classList.remove('request-workflow-scroll')
  }, [showRequestForm, showReview])

  useEffect(() => {
    if (!selectedVerificationPhoto) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setSelectedVerificationPhoto(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedVerificationPhoto])

  useEffect(() => {
    if (!selectedResidentHistoryRequestId) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setSelectedResidentHistoryRequestId(null)
        setSelectedFinishedCertificate(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedResidentHistoryRequestId])

  useEffect(() => {
    if (!residentCancellationRequestId) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setResidentCancellationRequestId('')
        setCancellationGcashError('')
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [residentCancellationRequestId])

  useEffect(() => {
    if (!selectedHistoryRequestId) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') {
        setSelectedHistoryRequestId(null)
        setSelectedFinishedCertificate(null)
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [selectedHistoryRequestId])

  useEffect(() => {
    if (expandedOfficialIndex === null) return undefined
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setExpandedOfficialIndex(null)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [expandedOfficialIndex])

  useEffect(() => {
    if (!showOfficialDashboard || adminView !== 'certificateProcessing') return undefined
    const frame = window.requestAnimationFrame(() => {
      if (welcomePageRef.current) welcomePageRef.current.scrollTop = 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [adminView, showOfficialDashboard])

  useEffect(() => {
    if (adminContentRef.current) adminContentRef.current.scrollTop = 0
  }, [adminView, showOfficialDashboard])

  const registrationInboxRequests = registrationRequests.filter((request) => {
    const requestName = request.data
      ? [request.data.firstName, request.data.middleName, request.data.lastName].filter(Boolean).join(' ')
      : request.name
    const code = residentName.code.trim().toUpperCase()
    return residentNameMatches(request.name || requestName, residentName, request.data)
      && [request.id, request.assignedResidentCode].includes(code)
  })

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const loadDatabaseData = async () => {
      if (officialBackendToken) {
        setDatabaseSaveStatus('checking')
        setDatabaseSaveError('')
      }
      const browserResidentRecords = {}
      let localRegistrations = []
      let localOfficialPhotos = {}
      if (!officialBackendToken) {
        await Promise.all(residentLocalRecordKeys.map(async (key) => {
          const fallback = key === residentRequestsStorageKey ? initialRequests : []
          try {
            const records = await loadLocalResidentRecord(key, fallback)
            if (!Array.isArray(records)) throw new Error(`Saved ${key} must be a list.`)
            browserResidentRecords[key] = records
          } catch (error) {
            console.error(`Unable to restore ${key} from browser storage.`, error)
            browserResidentRecords[key] = readStoredList(key, fallback)
          }
        }))
        localRegistrations = readStoredList(registrationRequestsStorageKey, [])
        localOfficialPhotos = readStoredImageMap(officialPhotosStorageKey)
        try {
          localRegistrations = await loadLocalRegistrationRequests()
        } catch (error) {
          console.error('Unable to restore registration requests from local browser storage.', error)
        }
        try {
          localOfficialPhotos = await loadLocalOfficialPhotos()
        } catch (error) {
          console.error('Unable to restore official photos from local browser storage.', error)
        }
      }
      if (cancelled) return
      if (!officialBackendToken) {
        setRegistrationRequests(localRegistrations)
        setOfficialPhotos(localOfficialPhotos)
      }

      try {
        const response = await fetchWithTimeout(officialBackendToken ? API_URL : PUBLIC_COMMUNITY_API_URL, {
          method: 'GET',
          cache: 'no-store',
          ...(officialBackendToken ? { headers: { Authorization: `Bearer ${officialBackendToken}` } } : {}),
          signal: controller.signal,
        })
        if (cancelled) return
        const result = await readJsonResponse(response, 'Database request')
        if (!response.ok) {
          if (officialBackendToken && response.status === 401) {
            setOfficialBackendToken('')
            setIsDatabaseConnected(false)
            setShowOfficialDashboard(false)
            setShowOfficialLogin(true)
            setLoginStatus('Your admin session is no longer valid. Sign in again to reconnect.')
          }
          throw new Error(result?.message || `Database request failed with status ${response.status}.`)
        }

        if (!result.success) {
          throw new Error('Unable to load database records.')
        }
        if (officialBackendToken) databaseEtagRef.current = response.headers.get('ETag') || ''

        const data = result.data || {}

        const loadValue = (key, fallback) => {
          if (Object.prototype.hasOwnProperty.call(data, key)) {
            return data[key]
          }

          if (officialBackendToken) return fallback

          const localData = window.localStorage.getItem(key)

          if (localData !== null) {
            try {
              return JSON.parse(localData)
            } catch {
              return fallback
            }
          }

          return fallback
        }
        const loadMergedList = (key, fallback, label) => {
          const databaseRecords = loadValue(key, fallback)
          if (officialBackendToken) {
            return mergePersistedRecordLists(databaseRecords, [], label)
          }
          const browserRecords = Object.prototype.hasOwnProperty.call(browserResidentRecords, key)
            ? browserResidentRecords[key]
            : readStoredList(key, [])
          return mergePersistedRecordLists(databaseRecords, browserRecords, label)
        }

        const updates = loadValue(communityUpdatesStorageKey, initialCommunityUpdates)
        const savedBarangayContactInformation = normalizeBarangayContactInformation(
          loadValue(barangayContactInformationStorageKey, initialBarangayContactInformation),
        )
        try {
          window.localStorage.setItem(barangayContactInformationStorageKey, JSON.stringify(savedBarangayContactInformation))
        } catch (error) {
          console.error('Unable to cache barangay contact information in browser storage.', error)
        }
        const deletedRequestIds = loadValue(residentRequestDeletionsStorageKey, [])
        if (!Array.isArray(deletedRequestIds) || !deletedRequestIds.every((id) => typeof id === 'string')) {
          throw new Error('Saved deleted request IDs must be a list of request IDs.')
        }
        const deletedRequestIdSet = new Set(deletedRequestIds)
        const excludeDeletedRequestRecords = (records) => records.filter((record) => (
          !deletedRequestIdSet.has(record.requestId || record.id)
        ))
        const paymentDrafts = excludeDeletedRequestRecords(
          loadMergedList(residentPaymentDraftsStorageKey, [], 'resident payment drafts'),
        )
        const savedResidentDrafts = excludeDeletedRequestRecords(
          loadMergedList(residentDraftsStorageKey, [], 'resident request drafts'),
        )
        const codeRecoveryRequests = loadMergedList(residentCodeRecoveryRequestsStorageKey, [], 'resident code recovery requests')
        const reconciledResidents = reconcileResidentCodeRotationRecords(
          loadMergedList(residentRecordsStorageKey, initialResidentRecords, 'resident records'),
          codeRecoveryRequests,
        )
        const { residents, removedCount: duplicateResidentCount } = deduplicateResidentRecordsByName(reconciledResidents)
        if (duplicateResidentCount) {
          setResidentAccountMessage(`${duplicateResidentCount} duplicate resident record${duplicateResidentCount === 1 ? ' was' : 's were'} removed. The oldest record for each name was kept.`)
        }
        const history = excludeDeletedRequestRecords(
          loadMergedList(residentHistoryStorageKey, [], 'resident history'),
        )
        const archived = loadMergedList(archivedResidentsStorageKey, [], 'archived residents')
        const issued = excludeDeletedRequestRecords(
          loadMergedList(issuedDocumentsStorageKey, [], 'issued documents'),
        )
        const customTemplates = loadValue(certificateTemplatesStorageKey, [])
        const hasValidTemplateLocation = (field) => (
          field && typeof field.key === 'string'
          && typeof field.label === 'string'
          && Number.isInteger(field.paragraph)
          && Number.isInteger(field.textNodeIndex)
        )
        if (!Array.isArray(customTemplates) || !customTemplates.every((template) => (
          template && typeof template.id === 'string'
          && typeof template.name === 'string'
          && typeof template.contentBase64 === 'string'
          && template.contentBase64.length <= 5000000
          && Array.isArray(template.fields)
          && template.fields.length > 0
          && template.fields.every((field) => (
            hasValidTemplateLocation(field)
            || (field && typeof field.key === 'string'
              && typeof field.label === 'string'
              && Array.isArray(field.targets)
              && field.targets.length > 0
              && field.targets.every(hasValidTemplateLocation))
          ))
          && Array.isArray(template.requirements)
          && template.requirements.every((requirement) => typeof requirement === 'string' && requirement.trim())
        ))) {
          throw new Error('Saved custom certificate templates must include valid DOCX files, fields, and requirements.')
        }
        if (customTemplates.reduce((total, template) => total + template.contentBase64.length, 0) > 5000000) {
          throw new Error('Saved custom certificate templates exceed the 5 MB shared-storage limit.')
        }
        const requests = splitMultiDocumentRequests(
          loadMergedList(residentRequestsStorageKey, initialRequests, 'resident requests')
            .filter((request) => !deletedRequestIdSet.has(request.id))
            .map(withRequestStatusHistory),
          customTemplates,
        )
        const enabledTemplates = loadValue(enabledCertificateTypesStorageKey, initialEnabledCertificateTypes)
        if (!Array.isArray(enabledTemplates) || !enabledTemplates.every((document) => typeof document === 'string')) {
          throw new Error('Saved enabled certificate types must be a list of document names.')
        }
        const restoredRequests = restoreUnprintedApprovedRequests(requests, history)
        const remoteRegistrations = loadValue(registrationRequestsStorageKey, [])
        if (!Array.isArray(remoteRegistrations)) {
          throw new Error('Saved registration requests must be a list.')
        }
        const registrations = migrateInitialResidentsToRegistrationHistory(
          mergeRegistrationRequestLists(remoteRegistrations, officialBackendToken ? [] : localRegistrations),
          residents,
        )
        const profileUpdates = loadMergedList(residentProfileUpdateRequestsStorageKey, [], 'resident profile update requests')
        const profiles = loadValue(officialProfilesStorageKey, initialOfficialProfiles)
        const photos = normalizeOfficialPhotoMap(
          Object.prototype.hasOwnProperty.call(data, officialPhotosStorageKey)
            ? data[officialPhotosStorageKey]
            : officialBackendToken ? {} : localOfficialPhotos,
        )
        if (!photos) throw new Error('Saved official photos must be an image map or a legacy list of photo strings.')
        const recipients = loadValue(gcashRecipientsStorageKey, initialGcashRecipients)
        if (!isValidGcashRecipientList(recipients)) {
          throw new Error('Saved GCash recipients must be a list of named phone numbers.')
        }
        const savedFees = loadValue(documentFeesStorageKey, initialDocumentFees)
        const savedFeeDefaultsVersion = Object.prototype.hasOwnProperty.call(data, documentFeesDefaultsVersionStorageKey)
          ? data[documentFeesDefaultsVersionStorageKey]
          : 0
        const fees = migrateDocumentFees(savedFees, savedFeeDefaultsVersion, [
          ...barangayDocuments,
          ...customTemplates.map((template) => template.name),
        ])
        const availability = loadValue(officialAvailabilityStorageKey, initialAvailability)
        const preferences = loadValue(adminPreferencesStorageKey, {
          darkMode: false,
          fontSize: 'standard',
          autoLogoutMinutes: 30,
        })

        setCommunityUpdates(updates)
        setBarangayContactInformation(savedBarangayContactInformation)
        setBarangayContactInformationDraft(null)
        setResidentRequests(restoredRequests.requests)
        setResidentPaymentDrafts(paymentDrafts)
        setResidentDrafts(savedResidentDrafts)
        setAdminResidents(residents)
        setResidentHistory(restoredRequests.history)
        setArchivedResidents(archived)
        setIssuedDocuments(issued)
        setCustomCertificateTemplates(customTemplates)
        setEnabledCertificateTypes(enabledTemplates)
        setRegistrationRequests(registrations)
        setResidentCodeRecoveryRequests(codeRecoveryRequests)
        setResidentProfileUpdateRequests(profileUpdates)
        setOfficialProfiles(profiles)
        setOfficialPhotos(photos)
        gcashRecipientsRef.current = recipients
        setGcashRecipients(recipients)
        setDocumentFees(fees)
        setOfficialAvailability(availability)

        setDarkMode(Boolean(preferences.darkMode))
        setFontSize(preferences.fontSize === 'large' ? 'large' : 'standard')
        setAutoLogoutMinutes([0, 15, 30, 60].includes(Number(preferences.autoLogoutMinutes))
          ? Number(preferences.autoLogoutMinutes)
          : 30)
        const records = {
          [communityUpdatesStorageKey]: updates,
          [barangayContactInformationStorageKey]: savedBarangayContactInformation,
          [residentRequestsStorageKey]: restoredRequests.requests,
          [residentRequestDeletionsStorageKey]: deletedRequestIds,
          [residentPaymentDraftsStorageKey]: paymentDrafts,
          [residentDraftsStorageKey]: savedResidentDrafts,
          [residentRecordsStorageKey]: residents,
          [residentHistoryStorageKey]: restoredRequests.history,
          [archivedResidentsStorageKey]: archived,
          [issuedDocumentsStorageKey]: issued,
          [certificateTemplatesStorageKey]: customTemplates,
          [enabledCertificateTypesStorageKey]: enabledTemplates,
          [documentFeesStorageKey]: fees,
          [documentFeesDefaultsVersionStorageKey]: documentFeesDefaultsVersion,
          [adminPreferencesStorageKey]: preferences,
          [officialAvailabilityStorageKey]: availability,
          [registrationRequestsStorageKey]: registrations,
          [residentCodeRecoveryRequestsStorageKey]: codeRecoveryRequests,
          [residentProfileUpdateRequestsStorageKey]: profileUpdates,
          [officialProfilesStorageKey]: profiles,
          [officialPhotosStorageKey]: photos,
          [gcashRecipientsStorageKey]: recipients,
        }

        const recoveredRecords = Object.fromEntries(
          Object.entries(records).filter(([key, value]) => (
            !Object.prototype.hasOwnProperty.call(data, key)
            || JSON.stringify(data[key]) !== JSON.stringify(value)
          )),
        )
        if (officialBackendToken && Object.keys(recoveredRecords).length) {
          await saveDatabaseRecords(recoveredRecords, officialBackendToken)
        }
        databaseRecordsRef.current = records
        try {
          window.localStorage.setItem(residentRequestDeletionsStorageKey, JSON.stringify(deletedRequestIds))
        } catch (error) {
          console.error('Unable to cache deleted request IDs in browser storage.', error)
        }

        setDatabaseSaveError('')
        setDatabaseSaveStatus(officialBackendToken ? 'saved' : 'offline')
        setIsDatabaseConnected(Boolean(officialBackendToken))
        setIsPublicCommunityConnected(true)
        console.log(officialBackendToken
          ? 'Barangay records loaded from database.'
          : 'Public community records loaded from database.')
      } catch (error) {
        if (cancelled) return
        console.error('Database loading error:', error)
        setIsPublicCommunityConnected(false)
        const localTemplates = readStoredList(certificateTemplatesStorageKey, [])
        const localRequests = splitMultiDocumentRequests(
          (browserResidentRecords[residentRequestsStorageKey] || loadResidentRequests()).map(withRequestStatusHistory),
          localTemplates,
        )
        const restoredLocalRequests = restoreUnprintedApprovedRequests(
          localRequests,
          browserResidentRecords[residentHistoryStorageKey] || readStoredList(residentHistoryStorageKey, []),
        )
        residentRequestsRef.current = restoredLocalRequests.requests
        residentHistoryRef.current = restoredLocalRequests.history
        residentPaymentDraftsRef.current = browserResidentRecords[residentPaymentDraftsStorageKey] || []
        setResidentRequests(restoredLocalRequests.requests)
        setResidentHistory(restoredLocalRequests.history)
        setResidentPaymentDrafts(residentPaymentDraftsRef.current)
        setResidentDrafts(browserResidentRecords[residentDraftsStorageKey] || [])
        setDatabaseSaveError(error.message || 'The database could not be loaded.')
        setDatabaseSaveStatus('offline')
        setIsDatabaseConnected(false)
      } finally {
        if (!cancelled) setIsStorageLoaded(true)
      }
    }

    loadDatabaseData()
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [databaseLoadVersion, officialBackendToken])

  useEffect(() => {
    if (!isStorageLoaded || !showOfficialDashboard || !officialBackendToken) return undefined
    const controller = new AbortController()
    let requestPending = false
    const refreshBackendRegistrations = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const response = await fetchWithTimeout(`${BACKEND_API_URL}/pending-registrations.php`, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${officialBackendToken}` },
          signal: controller.signal,
        })
        const result = await response.json()
        if (!response.ok || !result.success || !Array.isArray(result.data)) {
          throw new Error(result.message || 'The registration service returned an invalid response.')
        }

        const pendingRequests = result.data.map(mapBackendRegistrationRequest)
        setRegistrationRequests((requests) => mergeRegistrationRequestLists(pendingRequests, requests))
        setRegistrationSyncError('')
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to load pending registrations from the resident database.', error)
          const isConnectionError = /failed to fetch/i.test(error.message || '')
          setRegistrationSyncError(isConnectionError
            ? 'The registration service is unavailable. Saved applications remain visible; try again when the connection is restored.'
            : error.message || 'Pending account registrations could not be loaded.')
        }
      } finally {
        requestPending = false
      }
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshBackendRegistrations()
    }
    refreshBackendRegistrations()
    const refreshTimer = window.setInterval(refreshBackendRegistrations, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshBackendRegistrations)
    window.addEventListener('online', refreshBackendRegistrations)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshBackendRegistrations)
      window.removeEventListener('online', refreshBackendRegistrations)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      controller.abort()
    }
  }, [isStorageLoaded, officialBackendToken, showOfficialDashboard])

  useEffect(() => {
    if (!isStorageLoaded || isDatabaseConnected || !officialBackendToken) return undefined
    const controller = new AbortController()
    let requestPending = false
    const retryDatabaseConnection = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const response = await fetchWithTimeout(API_URL, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${officialBackendToken}` },
          signal: controller.signal,
        })
        if (response.status === 401) {
          setOfficialBackendToken('')
          setIsDatabaseConnected(false)
          setShowOfficialDashboard(false)
          setShowOfficialLogin(true)
          setLoginStatus('Your admin session is no longer valid. Sign in again to reconnect.')
          return
        }
        if (!response.ok) throw new Error(`Database reconnection failed with status ${response.status}.`)
        const result = await response.json()
        if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
          throw new Error('The server returned invalid database records during reconnection.')
        }
        databaseEtagRef.current = response.headers.get('ETag') || ''

        if (databaseRecordsRef.current) {
          setDatabaseSaveError('')
          setIsDatabaseConnected(true)
        } else {
          setDatabaseSaveStatus('checking')
          setDatabaseLoadVersion((version) => version + 1)
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to reconnect to the application database.', error)
        }
      } finally {
        requestPending = false
      }
    }

    const retryWhenVisible = () => {
      if (document.visibilityState === 'visible') retryDatabaseConnection()
    }
    retryDatabaseConnection()
    const retryTimer = window.setInterval(retryDatabaseConnection, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', retryDatabaseConnection)
    window.addEventListener('online', retryDatabaseConnection)
    document.addEventListener('visibilitychange', retryWhenVisible)
    return () => {
      window.clearInterval(retryTimer)
      window.removeEventListener('focus', retryDatabaseConnection)
      window.removeEventListener('online', retryDatabaseConnection)
      document.removeEventListener('visibilitychange', retryWhenVisible)
      controller.abort()
    }
  }, [applySharedCommunityRecords, isStorageLoaded, isDatabaseConnected, officialBackendToken])

  const archivedDocumentRequests = residentHistory
    .filter((entry) => entry.type === 'documentRequest' && entry.request)
    .map((entry) => entry.request)
  const getRequestResidentName = (request) => {
    const certificateDetails = [
      ...Object.values(request.certificateData || {}),
      ...Object.values(request.detailsByDocument || {}),
    ]
    const savedName = [
      request.resident,
      request.name,
      request.fullName,
      request.full_name,
      request.data?.fullName,
      request.details?.fullName,
      request.details?.full_name,
      request.details?.name,
      ...certificateDetails.flatMap((details) => [
        details?.fullName,
        details?.full_name,
        details?.name,
      ]),
    ].map((value) => String(value || '').trim()).find(Boolean)
    if (savedName) return savedName

    const residentCode = normalizeResidentCode(request.residentCode || request.resident_code)
    const resident = residentCode && adminResidents.find((candidate) => (
      normalizeResidentCode(candidate.code || candidate.residentCode || candidate.id) === residentCode
    ))
    const registration = residentCode && registrationRequests.find((candidate) => (
      normalizeResidentCode(candidate.assignedResidentCode) === residentCode
    ))
    const requestDetails = request.details || {}
    const detailsName = [
      requestDetails.firstName || requestDetails.first_name || requestDetails.givenName,
      requestDetails.middleName || requestDetails.middle_name,
      requestDetails.lastName || requestDetails.last_name || requestDetails.familyName,
      requestDetails.suffix,
    ].filter(Boolean).join(' ')
    const certificateDetailsName = certificateDetails.map((details) => [
      details?.firstName || details?.first_name || details?.givenName,
      details?.middleName || details?.middle_name,
      details?.lastName || details?.last_name || details?.familyName,
      details?.suffix,
    ].filter(Boolean).join(' ')).find(Boolean)
    return [
      resident?.name,
      resident?.fullName,
      resident?.full_name,
      registration?.name,
      registration?.data?.fullName,
      registration?.data?.full_name,
      detailsName,
      certificateDetailsName,
    ].map((value) => String(value || '').trim()).find(Boolean) || 'Resident name not recorded'
  }
  const allDocumentRequests = Array.from(new Map(
    [...residentRequests, ...archivedDocumentRequests].map((request) => [request.id, request]),
  ).values()).map((request) => ({ ...request, resident: getRequestResidentName(request) }))
  const residentAccountRequests = allDocumentRequests.filter((request) => residentRecordMatchesAccount(request, residentName))
  const residentCancellationRequest = residentAccountRequests.find((request) => request.id === residentCancellationRequestId)
  const residentInboxRequests = residentAccountRequests.filter(isRequestSubmittedToAdmin)
  const residentCorrectionRequests = residentInboxRequests.filter((request) => request.status === 'Returned for edits')
  const residentCancelledRequests = residentAccountRequests.filter((request) => request.status === 'Cancelled')
  const residentPendingPaymentRequests = residentPaymentDrafts.filter((request) => (
    request.awaitingPaymentSubmission && residentRecordMatchesAccount(request, residentName)
  ))
  const residentPaymentRequests = [
    ...residentAccountRequests.filter((request) => Number(request.feeAmount || 0) > 0),
    ...residentPendingPaymentRequests,
  ].sort((first, second) => new Date(second.requestedAt || second.paymentDraftedAt || 0).getTime()
    - new Date(first.requestedAt || first.paymentDraftedAt || 0).getTime())
  const residentPaymentHistoryRequests = residentPaymentRequests
    .filter((request) => Number(request.feeAmount || 0) > 0 && request.paymentStatus === 'Paid')
    .sort((first, second) => new Date(second.paymentVerifiedAt || second.paymentSubmittedAt || second.requestedAt || 0).getTime()
      - new Date(first.paymentVerifiedAt || first.paymentSubmittedAt || first.requestedAt || 0).getTime())
  const residentPaymentRecords = groupPaymentRequests(residentPaymentRequests)
  const unpaidResidentPaymentRequests = residentPaymentRequests.filter((request) => (
    request.status !== 'Cancelled'
    && !['Paid', 'Pending verification'].includes(request.paymentStatus || 'Unpaid')
  ))
  const selectedResidentPaymentRequests = unpaidResidentPaymentRequests.filter((request) => (
    selectedPaymentRequestIds.includes(request.id)
  ))
  const selectedResidentPaymentTotal = selectedResidentPaymentRequests.reduce((total, request) => (
    total + Number(request.feeAmount || 0)
  ), 0)
  const hasStalePaymentSelection = selectedResidentPaymentRequests.length !== selectedPaymentRequestIds.length
  const residentPaymentBalance = residentPaymentRequests
    .filter((request) => request.status !== 'Cancelled'
      && !['Paid', 'Pending verification'].includes(request.paymentStatus || 'Unpaid'))
    .reduce((total, request) => total + Number(request.feeAmount || 0), 0)
  const selectedInboxRequest = residentInboxRequests.find((request) => request.id === selectedInboxRequestId)
  const residentPickupRequests = residentInboxRequests
    .filter((request) => request.status === 'Ready for release')
    .sort((first, second) => (first.pickupDate || '9999-12-31').localeCompare(second.pickupDate || '9999-12-31'))
  const residentRequestActivityNotifications = residentAccountRequests.flatMap((request) => {
    const requestLabel = `${request.documents?.join(' · ') || 'Document request'} · ${request.id}`
    return (request.activity || []).flatMap((activity, index) => {
      if (String(activity.by || '').trim().toLowerCase() === 'resident' || !activity.action) return []
      const action = String(activity.action).trim()
      let title = action.split(':')[0]
      let description = requestLabel
      let section = 'requests'
      let category = 'requests'

      if (/^payment marked paid/i.test(action)) {
        if (request.paymentStatus !== 'Paid') return []
        title = 'Payment confirmed'
        description = `${requestLabel} · OR No. ${request.paymentOrNumber || action.split('OR No. ')[1] || 'recorded'}`
        section = 'payments'
        category = 'payments'
      } else if (/^manual gcash refund recorded/i.test(action)) {
        if (request.refundStatus !== 'Refunded') return []
        title = 'Refund recorded'
        description = `${requestLabel} · ₱${Number(request.feeAmount || 0).toFixed(2)} refunded${request.refundTransactionNumber ? ` · GCash reference ${request.refundTransactionNumber}` : ''}`
        section = 'payments'
        category = 'payments'
      } else if (/^pickup information (updated and sent|sent)/i.test(action)) {
        title = /^pickup information updated/i.test(action) ? 'Pickup schedule updated' : 'Pickup details sent'
        description = `${requestLabel} · ${action.replace(/^Pickup information (?:updated and sent|sent):?\s*/i, '')}`
        section = 'pickup'
        category = 'pickup'
      } else if (/^edits requested:/i.test(action)) {
        title = 'Corrections requested'
        description = `${requestLabel} · ${action.replace(/^Edits requested:\s*/i, '')}`
        category = 'corrections'
      } else if (/^request declined:/i.test(action)) {
        title = 'Request declined'
        description = `${requestLabel} · ${action.replace(/^Request declined:\s*/i, '')}`
      } else if (/^all requested documents are prepared/i.test(action)) {
        title = 'Documents ready for pickup'
        description = requestLabel
        section = 'pickup'
        category = 'pickup'
      } else if (/^started review/i.test(action)) {
        title = 'Request is under review'
        description = `${requestLabel}${action.includes(':') ? ` · ${action.split(':').slice(1).join(':').trim()}` : ''}`
      } else if (/^approved and forwarded/i.test(action)) {
        title = 'Request approved for processing'
        description = `${requestLabel}${action.includes(':') ? ` · ${action.split(':').slice(1).join(':').trim()}` : ''}`
      } else if (action.includes(':')) {
        description = `${requestLabel} · ${action.split(':').slice(1).join(':').trim()}`
      }
      if ((section === 'requests'
        && (!residentInboxRequests.some((inboxRequest) => inboxRequest.id === request.id)
          || ['Completed', 'Declined', 'Cancelled'].includes(request.status)))
        || (section === 'pickup' && request.status !== 'Ready for release')) {
        section = 'history'
      }

      return [{
        id: `request-activity-${request.id}-${index}`,
        title,
        description,
        section,
        category,
        requestId: request.id,
        time: activity.time || '',
        sortTime: new Date(activity.time || 0).getTime() || 0,
      }]
    })
  })
  const residentCorrectionFallbackNotifications = residentCorrectionRequests.flatMap((request) => {
    if (residentRequestActivityNotifications.some((item) => item.requestId === request.id && item.category === 'corrections')) return []
    const correctionActivity = (request.statusHistory || []).slice().reverse()
      .find((activity) => activity.status === 'Returned for edits')
    const time = correctionActivity?.changedAt || request.updatedAt || ''
    return [{
      id: `request-correction-${request.id}-${time || 'returned'}`,
      title: 'Corrections requested',
      description: `${request.documents?.join(' · ') || 'Document request'} · ${request.id}${request.editRequestNote ? ` · ${request.editRequestNote}` : ''}`,
      section: 'requests',
      category: 'corrections',
      requestId: request.id,
      time,
      sortTime: new Date(time || 0).getTime() || 0,
    }]
  })
  const residentCancellationNotifications = residentCancelledRequests.map((request) => {
    const cancellationActivity = (request.statusHistory || []).slice().reverse()
      .find((activity) => activity.status === 'Cancelled')
    const time = request.cancelledAt || cancellationActivity?.changedAt || ''
    const sharedPayment = residentPaymentRecords.find((payment) => payment.requestIds.includes(request.id))
    const cancelledPaymentNote = Number(request.feeAmount || 0) > 0
      ? request.paymentStatus === 'Paid'
        ? ` · Paid fee ₱${Number(request.feeAmount || 0).toFixed(2)}${request.refundStatus === 'Refunded' ? ' · refund recorded' : ' · refund follow-up pending'}`
        : request.paymentStatus === 'Pending verification'
          ? ' · Shared payment proof is being verified'
          : ' · Removed from balance to pay'
      : ''
    const sharedPaymentNote = sharedPayment?.requests.length > 1
      ? ` · ${sharedPayment.requests.length} combined requests (${sharedPayment.cancelledRequestCount} cancelled)`
      : ''
    return {
      id: `request-cancelled-${request.id}-${time || 'cancelled'}`,
      title: 'Request cancelled',
      description: `${request.documents?.join(' · ') || 'Document request'} · ${request.id}${cancelledPaymentNote}${sharedPaymentNote}`,
      section: 'drafts-corrections',
      category: 'cancelled',
      requestId: request.id,
      time,
      sortTime: new Date(time || 0).getTime() || 0,
    }
  })
  const residentRefundFallbackNotifications = residentAccountRequests.flatMap((request) => {
    if (request.refundStatus !== 'Refunded'
      || residentRequestActivityNotifications.some((item) => item.requestId === request.id && item.title === 'Refund recorded')) return []
    const time = request.refundedAt || request.updatedAt || ''
    return [{
      id: `request-refund-${request.id}-${time || 'refunded'}`,
      title: 'Refund recorded',
      description: `${request.documents?.join(' · ') || 'Document request'} · ${request.id} · ₱${Number(request.feeAmount || 0).toFixed(2)} refunded${request.refundTransactionNumber ? ` · GCash reference ${request.refundTransactionNumber}` : ''}`,
      section: 'payments',
      category: 'payments',
      requestId: request.id,
      time,
      sortTime: new Date(time || 0).getTime() || 0,
    }]
  })
  const residentPendingPaymentNotifications = residentPendingPaymentRequests.map((request) => {
    const time = request.paymentDraftedAt || request.updatedAt || request.requestedAt || ''
    return {
      id: `payment-draft-${request.id}`,
      title: 'Unpaid request needs payment',
      description: `${request.documents?.join(' · ') || 'Document request'} · ${request.id}`,
      section: 'payments',
      category: 'payments',
      requestId: request.id,
      time,
      sortTime: new Date(time || 0).getTime() || 0,
    }
  })
  const residentCommunityUpdateNotifications = communityUpdates.map((update) => {
    const time = update.updatedAt || update.createdAt || update.date || ''
    return {
      id: getResidentCommunityUpdateId(update),
      title: update.type === 'event' ? 'New community event' : 'New announcement',
      description: update.title,
      section: 'community',
      category: 'community',
      time,
      sortTime: new Date(time || 0).getTime() || 0,
    }
  })
  const residentProfileUpdateNotifications = residentProfileUpdateRequests
    .filter((request) => (
      String(request.residentCode || '').trim().toLowerCase() === residentName.code.trim().toLowerCase()
      && request.reviewedAt
    ))
    .map((request) => {
      const time = request.reviewedAt
      const status = String(request.status || 'updated').toLowerCase()
      return {
        id: `profile-update-${getAdminNavigationItemId(request)}`,
        title: `Profile update ${status}`,
        description: `Your profile update request ${request.id} was ${status}.`,
        section: 'profile',
        category: 'profile',
        time,
        sortTime: new Date(time || 0).getTime() || 0,
      }
    })
  const residentNotificationItems = [
    ...residentRequestActivityNotifications,
    ...residentCorrectionFallbackNotifications,
    ...residentCancellationNotifications,
    ...residentRefundFallbackNotifications,
    ...residentPendingPaymentNotifications,
    ...residentCommunityUpdateNotifications,
    ...residentProfileUpdateNotifications,
  ].sort((first, second) => second.sortTime - first.sortTime)
  const residentCancelledUpdateItems = residentCancelledRequests.map((request) => {
    const cancellationActivity = (request.statusHistory || []).slice().reverse()
      .find((activity) => activity.status === 'Cancelled')
    const time = request.cancelledAt || cancellationActivity?.changedAt || ''
    return { id: `request-cancelled-${request.id}-${time || 'cancelled'}` }
  })
  const residentNotificationReadCode = residentName.code.trim().toLowerCase()
  const residentNotificationReadGroups = residentNotificationReadState[residentNotificationReadCode] || {}
  const residentRequestUpdateItems = residentNotificationItems.filter((item) => (
    item.section === 'requests' && ['requests', 'corrections'].includes(item.category)
  ))
  const residentHistoryUpdateItems = residentNotificationItems.filter((item) => item.section === 'history')
  const residentPaymentUpdateItems = residentNotificationItems.filter((item) => item.category === 'payments')
  const residentPickupUpdateItems = residentNotificationItems.filter((item) => item.section === 'pickup' && item.category === 'pickup')
  const residentCorrectionUpdateItems = residentNotificationItems.filter((item) => item.section === 'requests' && item.category === 'corrections')
  const residentCommunityUpdateItems = residentNotificationItems.filter((item) => (
    item.section === 'community' && item.category === 'community'
  ))
  const residentProfileUpdateItems = residentNotificationItems.filter((item) => (
    item.section === 'profile' && item.category === 'profile'
  ))
  const isResidentUpdateUnread = (item) => {
    const readGroup = item.section === 'history' ? 'history' : item.category
    return !(residentNotificationReadGroups[readGroup]?.includes(item.id))
  }
  const getResidentUnreadCount = (group, items) => {
    const readIds = new Set(residentNotificationReadGroups[group] || [])
    return items.filter((item) => !readIds.has(item.id)).length
  }
  const residentNotificationUnreadCount = getResidentUnreadCount('notifications', residentNotificationItems)
  const residentRequestUnreadCount = residentRequestUpdateItems.filter(isResidentUpdateUnread).length
  const residentPaymentUnreadCount = getResidentUnreadCount('payments', residentPaymentUpdateItems)
  const residentPickupUnreadCount = getResidentUnreadCount('pickup', residentPickupUpdateItems)
  const residentCorrectionUnreadCount = getResidentUnreadCount('corrections', residentCorrectionUpdateItems)
  const residentCancelledUnreadCount = getResidentUnreadCount('cancelled', residentCancelledUpdateItems)
  const residentHistoryUnreadCount = getResidentUnreadCount('history', residentHistoryUpdateItems)
  const residentCommunityUnreadCount = getResidentUnreadCount('community', residentCommunityUpdateItems)
  const residentProfileUnreadCount = getResidentUnreadCount('profile', residentProfileUpdateItems)
  const markResidentUpdatesRead = useCallback((group, itemIds) => {
    const residentCode = residentName.code.trim().toLowerCase()
    const validItemIds = itemIds.filter(Boolean)
    if (!residentCode || !validItemIds.length) return
    setResidentNotificationReadState((current) => {
      const previousGroups = current[residentCode] || {}
      const previousIds = Array.isArray(previousGroups[group]) ? previousGroups[group] : []
      const nextIds = Array.from(new Set([...previousIds, ...validItemIds])).slice(-1000)
      if (nextIds.length === previousIds.length && nextIds.every((id, index) => id === previousIds[index])) return current
      return { ...current, [residentCode]: { ...previousGroups, [group]: nextIds } }
    })
  }, [residentName.code])
  const markResidentRequestUpdatesRead = (requestId = '') => {
    const requestItems = residentRequestUpdateItems.filter((item) => !requestId || item.requestId === requestId)
    const requestGroups = ['requests', 'corrections']
    requestGroups.forEach((group) => {
      markResidentUpdatesRead(group, requestItems.filter((item) => item.category === group).map((item) => item.id))
    })
  }
  const markResidentDashboardSectionRead = (section, category = residentDraftsCorrectionsTab) => {
    if (section === 'drafts-corrections' && category === 'cancelled') {
      markResidentUpdatesRead('cancelled', residentCancelledUpdateItems.map((item) => item.id))
    }
    if (section === 'profile') markResidentUpdatesRead('profile', residentProfileUpdateItems.map((item) => item.id))
  }
  const residentDashboardSectionUnreadCounts = {
    requests: residentRequestUnreadCount,
    pickup: residentPickupUnreadCount,
    payments: residentPaymentUnreadCount,
    'drafts-corrections': residentCorrectionUnreadCount + residentCancelledUnreadCount,
    history: residentHistoryUnreadCount,
    community: residentCommunityUnreadCount,
  }
  const residentDashboardSections = [
    { id: 'community', title: 'Community', description: 'Explore announcements, events, and barangay officials.', icon: '▦' },
    { id: 'pickup', title: 'Pickup', description: 'View release schedules and collection instructions for ready documents.', icon: '◷' },
    { id: 'request-documents', title: 'Request Documents', description: 'Apply for barangay certificates and other documents.', icon: '▤' },
    { id: 'requests', title: 'My Requests', description: 'Track pending, reviewed, approved, and completed requests.', icon: '▤' },
    { id: 'drafts-corrections', title: 'Drafts & corrections', description: 'Continue saved requests or replace documents returned for correction.', icon: '▧' },
    { id: 'payments', title: 'Payment tracking', description: 'Review document fees and submit payment proof.', icon: '₱' },
    { id: 'history', title: 'Request History', description: 'Review completed requests and their processing history.', icon: '◷' },
    { id: 'profile', title: 'My Profile', description: 'View your details, request profile changes, and track approvals.', icon: '♙' },
  ]
  const renderResidentProfileUpdatePanel = (currentProfileValues, profileUpdates) => (
    <section className="resident-profile-update-panel">
      <div className="resident-profile-update-heading">
        <span className="resident-profile-update-heading-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" /></svg></span>
        <div><h3>Request profile update</h3><p>Send your corrected details to the secretary. Changes appear on your profile after approval.</p></div>
      </div>
      {!profileUpdateFormOpen && <button type="button" className="resident-table-action" onClick={() => { setProfileUpdateForm(currentProfileValues); setProfileUpdateError(''); setProfileUpdateFormOpen(true) }}>Request profile update</button>}
      {profileUpdateFormOpen && <form className="resident-profile-update-form" onSubmit={submitProfileUpdateRequest}>
        <label>Date of birth<input type="date" value={profileUpdateForm.birthDate} onChange={(event) => setProfileUpdateForm({ ...profileUpdateForm, birthDate: event.target.value })} /></label>
        <label>Contact number<input type="tel" value={profileUpdateForm.contactNumber} onChange={(event) => setProfileUpdateForm({ ...profileUpdateForm, contactNumber: event.target.value })} placeholder="09XX XXX XXXX" /></label>
        <label>Email address<input type="email" value={profileUpdateForm.emailAddress} onChange={(event) => setProfileUpdateForm({ ...profileUpdateForm, emailAddress: event.target.value })} placeholder="you@example.com" /></label>
        <label>Home address<input value={profileUpdateForm.address} onChange={(event) => setProfileUpdateForm({ ...profileUpdateForm, address: event.target.value })} /></label>
        {profileUpdateError && <p className="community-update-error" role="alert">{profileUpdateError}</p>}
        <div><button type="submit" className="check-button">Send for approval</button><button type="button" className="cancel-button" onClick={() => { setProfileUpdateFormOpen(false); setProfileUpdateError('') }}>Cancel</button></div>
      </form>}
      {profileUpdates.length > 0 && <div className="resident-profile-update-history"><h4>Your profile update requests</h4>{profileUpdates.map((request) => <article key={request.id}><div><strong>{request.id}</strong><span>Submitted {new Date(request.submittedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })}</span></div><span className={`resident-status-badge ${request.status.toLowerCase()}`}>{request.status}</span>{request.reviewedAt && <small>{request.status} {new Date(request.reviewedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })}</small>}</article>)}</div>}
    </section>
  )
  const residentRequestDrafts = residentDrafts.filter((draft) => (
    residentRecordMatchesAccount(draft, residentName) && draft.status !== 'in-progress'
  ))
  const residentUpdateCount = residentInboxRequests.reduce((total, request) => total + (request.statusHistory || withRequestStatusHistory(request).statusHistory).filter((entry) => entry.status !== 'New').length, 0)
    + residentInboxRequests.filter((request) => request.pickupNotificationSentAt).length
    + registrationInboxRequests.filter((request) => request.reviewedAt).length
  const documentProcessingRequests = residentRequests.filter(isRequestReadyForDocumentProcessing)
  const documentInboxRequests = residentRequests.filter(isRequestSubmittedToAdmin)
  const pendingRegistrationRequests = registrationRequests.filter((request) => request.status === 'Pending')
  const registrationHistoryRequests = registrationRequests.filter((request) => request.status !== 'Pending')
  const registrationSearchQuery = registrationQueueSearch.trim().toLowerCase()
  const filteredPendingRegistrationRequests = pendingRegistrationRequests.filter((request) => [
    request.name,
    request.fullName,
    request.full_name,
    request.id,
    request.address,
    request.assignedResidentCode,
    request.data?.firstName,
    request.data?.middleName,
    request.data?.lastName,
    request.data?.residentCode,
  ].some((value) => String(value || '').toLowerCase().includes(registrationSearchQuery)))
  const pendingRegistrationCount = pendingRegistrationRequests.length
  const activeRegistrationReviewRequest = pendingRegistrationRequests.find((request) => request.id === expandedRegistrationId) || null
  const pendingRecoveryRequestCount = residentCodeRecoveryRequests.filter((request) => request.status === 'Pending').length
  const adminPaymentRecords = groupPaymentRequests(residentRequests.filter((request) => Number(request.feeAmount || 0) > 0))
  const activePaymentRecords = adminPaymentRecords
  const paymentAssessmentRecords = activePaymentRecords.filter((payment) => (
    payment.paymentStatus === 'Pending verification'
      && payment.requests.some((request) => request.status !== 'Cancelled')
  ))
  const paymentHistoryRecords = groupPaymentRequests(allDocumentRequests
    .filter((request) => Number(request.feeAmount || 0) > 0 && request.paymentStatus === 'Paid'))
    .sort((first, second) => new Date(second.paymentVerifiedAt || second.paymentSubmittedAt || second.requestedAt || 0).getTime()
      - new Date(first.paymentVerifiedAt || first.paymentSubmittedAt || first.requestedAt || 0).getTime())
  const getPaymentResidentContactNumber = (request) => {
    const resident = adminResidents.find((record) => record.code?.toLowerCase() === request.residentCode?.toLowerCase())
    const documentDetails = Object.values(request.detailsByDocument || {})
    return request.details?.contactNumber
      || request.details?.mobileNumber
      || documentDetails.find((details) => details.contactNumber || details.mobileNumber)?.contactNumber
      || documentDetails.find((details) => details.mobileNumber)?.mobileNumber
      || resident?.contactNumber
      || 'Not provided'
  }
  const cancelledPaymentRequests = residentRequests.filter((request) => (
    request.status === 'Cancelled'
    && ['Pending verification', 'Paid'].includes(request.paymentStatus)
    && Number(request.feeAmount || 0) > 0
  )).sort((first, second) => new Date(second.cancelledAt || 0).getTime() - new Date(first.cancelledAt || 0).getTime())
  const adminNavigationUnreadItems = {
    overview: [],
    documents: documentInboxRequests
      .filter((request) => ['New', 'For Verification', 'Returned for edits'].includes(request.status))
      .map((request) => `document:${getAdminNavigationItemId(request)}`),
    registrations: pendingRegistrationRequests
      .map((request) => `registration:${getAdminNavigationItemId(request)}`),
    announcements: [
      ...communityUpdates.map((update) => `community:${getAdminNavigationItemId(update)}`),
      ...officialAvailability.map((official) => `schedule:${getAdminNavigationItemId(official)}`),
    ],
    officials: officialProfiles.map((official, index) => (
      `official:${index}:${getAdminNavigationItemId(official)}`
    )),
    payments: [
      ...paymentAssessmentRecords.map((request) => `payment:${getAdminNavigationItemId(request)}`),
      ...cancelledPaymentRequests
        .filter((request) => request.paymentStatus === 'Pending verification' || request.refundStatus !== 'Refunded')
        .map((request) => `refund:${getAdminNavigationItemId(request)}`),
    ],
    residents: [
      ...adminResidents.filter((resident) => resident.createdAt || resident.updatedAt)
        .map((resident) => `resident:${getAdminNavigationItemId(resident)}`),
      ...residentCodeRecoveryRequests.filter((request) => request.status === 'Pending')
        .map((request) => `recovery:${getAdminNavigationItemId(request)}`),
      ...residentProfileUpdateRequests.filter((request) => request.status === 'Pending')
        .map((request) => `profile-update:${getAdminNavigationItemId(request)}`),
    ],
    certificateTemplates: [
      ...customCertificateTemplates.map((template) => `template:${getAdminNavigationItemId(template)}`),
      ...allCertificateDocuments.map((document) => `availability:${getAdminNavigationItemId({
        id: document,
        enabled: enabledCertificateTypes.includes(document),
        fee: documentFees[document] ?? 0,
      })}`),
    ],
    issuedDocuments: issuedDocuments.map((entry) => `issued:${getAdminNavigationItemId(entry)}`),
  }
  const adminNavigationUnreadCounts = Object.fromEntries(
    Object.entries(adminNavigationUnreadItems).map(([section, ids]) => {
      const readIds = new Set(adminNavigationReadState[section] || [])
      return [section, ids.filter((id) => !readIds.has(id)).length]
    }),
  )
  const markAdminNavigationItemsRead = (section, itemIds) => {
    const validItemIds = itemIds.filter(Boolean)
    if (!validItemIds.length) return
    setAdminNavigationReadState((current) => {
      const previousIds = current[section] || []
      const nextIds = Array.from(new Set([...previousIds, ...validItemIds])).slice(-1000)
      if (nextIds.length === previousIds.length && nextIds.every((id, index) => id === previousIds[index])) return current
      return { ...current, [section]: nextIds }
    })
  }
  const markAdminNavigationSectionRead = (section) => {
    markAdminNavigationItemsRead(section, adminNavigationUnreadItems[section] || [])
  }
  const isAdminNotificationUnread = (section, prefix, item) => (
    !(adminNavigationReadState[section] || []).includes(`${prefix}:${getAdminNavigationItemId(item)}`)
  )
  const markAdminNotificationRead = (section, prefix, item) => {
    markAdminNavigationItemsRead(section, [`${prefix}:${getAdminNavigationItemId(item)}`])
  }
  const getAdminCommunityUpdateId = (update) => `community:${getAdminNavigationItemId(update)}`
  const isAdminCommunityUpdateUnread = (update) => (
    !(adminNavigationReadState.announcements || []).includes(getAdminCommunityUpdateId(update))
  )
  const markAdminCommunityUpdateRead = (update) => {
    const updateId = getAdminCommunityUpdateId(update)
    markAdminNavigationItemsRead('announcements', [updateId])
  }
  const markAdminViewRead = (view) => {
    if (view === 'overview') markAdminNavigationSectionRead('overview')
    if (view === 'documents' || view === 'certificateProcessing') markAdminNavigationSectionRead('documents')
    if (view === 'registrations') markAdminNavigationSectionRead('registrations')
    if (view === 'announcements') markAdminNavigationSectionRead('announcements')
    if (view === 'officials') markAdminNavigationSectionRead('officials')
    if (view === 'payments' || view === 'refunds') markAdminNavigationSectionRead('payments')
    if (view === 'residents') markAdminNavigationSectionRead('residents')
    if (view === 'certificateTemplates') markAdminNavigationSectionRead('certificateTemplates')
    if (view === 'issuedDocuments') markAdminNavigationSectionRead('issuedDocuments')
  }
  const notificationCount = documentProcessingRequests.filter((request) => (
    request.status === 'New' && isAdminNotificationUnread('documents', 'document', request)
  )).length
    + documentInboxRequests.filter((request) => (
      request.status === 'For Verification' && isAdminNotificationUnread('documents', 'document', request)
    )).length
    + pendingRegistrationRequests.filter((request) => isAdminNotificationUnread('registrations', 'registration', request)).length
    + residentCodeRecoveryRequests.filter((request) => (
      request.status === 'Pending' && isAdminNotificationUnread('residents', 'recovery', request)
    )).length
    + residentProfileUpdateRequests.filter((request) => (
      request.status === 'Pending' && isAdminNotificationUnread('residents', 'profile-update', request)
    )).length
    + paymentAssessmentRecords.filter((request) => isAdminNotificationUnread('payments', 'payment', request)).length
    + cancelledPaymentRequests.filter((request) => (
      (request.paymentStatus === 'Pending verification' || request.refundStatus !== 'Refunded')
        && isAdminNotificationUnread('payments', 'refund', request)
    )).length
  const reportDate = new Date().toISOString().slice(0, 10)
  const requestDocumentOptions = [...new Set(residentRequests.flatMap((request) => request.documents || []))].sort((first, second) => first.localeCompare(second))
  const activeQueueRequests = documentInboxRequests
    .filter((request) => ['New', 'For Verification', 'Returned for edits', 'Under review', 'Approved - scheduling', 'Ready for release'].includes(request.status))
    .map((request) => ({ ...request, resident: getRequestResidentName(request) }))
  const documentQueueCounts = {
    incoming: activeQueueRequests.filter((request) => ['New', 'For Verification', 'Returned for edits'].includes(request.status)).length,
    review: activeQueueRequests.filter((request) => request.status === 'Under review').length,
    processing: activeQueueRequests.filter((request) => request.status === 'Approved - scheduling').length,
    release: activeQueueRequests.filter((request) => request.status === 'Ready for release').length,
  }
  const dashboardNeedsActionIds = new Set([
    ...documentInboxRequests.filter((request) => ['New', 'For Verification', 'Returned for edits'].includes(request.status)).map((request) => `document:${request.id}`),
    ...pendingRegistrationRequests.map((request) => `registration:${request.id}`),
    ...residentCodeRecoveryRequests.filter((request) => request.status === 'Pending').map((request) => `recovery:${request.id}`),
    ...paymentAssessmentRecords.map((request) => `payment:${request.id}`),
    ...residentProfileUpdateRequests.filter((request) => request.status === 'Pending').map((request) => `profile:${request.id}`),
    ...cancelledPaymentRequests.filter((request) => request.paymentStatus === 'Pending verification' || request.refundStatus !== 'Refunded').map((request) => `refund:${request.id}`),
  ])
  const dashboardPerformanceStages = [
    { label: 'Received', statuses: ['New', 'For Verification', 'Returned for edits'] },
    { label: 'Under review', statuses: ['Under review'] },
    { label: 'Processing', statuses: ['Approved - scheduling'] },
    { label: 'Ready for release', statuses: ['Ready for release'] },
    { label: 'Completed', statuses: ['Completed'] },
    { label: 'Declined', statuses: ['Declined'] },
    { label: 'Cancelled', statuses: ['Cancelled'] },
  ].map(({ label, statuses }) => ({
    label,
    count: allDocumentRequests.filter((request) => statuses.includes(request.status)).length,
  }))
  const dashboardClassifiedRequestCount = dashboardPerformanceStages.reduce((total, stage) => total + stage.count, 0)
  const dashboardOtherRequestCount = Math.max(0, allDocumentRequests.length - dashboardClassifiedRequestCount)
  if (dashboardOtherRequestCount) dashboardPerformanceStages.push({ label: 'Other', count: dashboardOtherRequestCount })
  const dashboardCompletedRequestCount = dashboardPerformanceStages.find((stage) => stage.label === 'Completed')?.count || 0
  const dashboardCompletionRate = allDocumentRequests.length
    ? Math.round((dashboardCompletedRequestCount / allDocumentRequests.length) * 100)
    : 0
  const dashboardPerformanceStagesWithShare = dashboardPerformanceStages.map((stage) => ({
    ...stage,
    share: allDocumentRequests.length ? Math.round((stage.count / allDocumentRequests.length) * 100) : 0,
  }))
  const dashboardPerformanceMax = Math.max(1, ...dashboardPerformanceStages.map((stage) => stage.count))
  const dashboardMonthlyPerformance = Array.from({ length: 6 }, (_, index) => {
    const monthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 5 + index, 1)
    const monthRequests = allDocumentRequests.filter((request) => {
      const requestDate = new Date(request.requestedAt || request.date || '')
      return !Number.isNaN(requestDate.getTime())
        && requestDate.getFullYear() === monthStart.getFullYear()
        && requestDate.getMonth() === monthStart.getMonth()
    })
    return {
      key: `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}`,
      label: monthStart.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      requests: monthRequests.length,
      completed: monthRequests.filter((request) => request.status === 'Completed').length,
    }
  })
  const dashboardMonthlyPerformanceMax = Math.max(1, ...dashboardMonthlyPerformance.map((month) => month.requests))
  const dashboardMonthlyPerformancePoints = dashboardMonthlyPerformance.map((month, index) => {
    const x = 48 + (index * 640) / Math.max(1, dashboardMonthlyPerformance.length - 1)
    const getY = (count) => 178 - ((count / dashboardMonthlyPerformanceMax) * 144)
    return { ...month, x, requestsY: getY(month.requests), completedY: getY(month.completed) }
  })
  const filteredResidentRequests = activeQueueRequests.filter((request) => {
    const matchesQueue = (documentQueueFilter === 'incoming' && ['New', 'For Verification', 'Returned for edits'].includes(request.status))
      || (documentQueueFilter === 'review' && request.status === 'Under review')
      || (documentQueueFilter === 'processing' && request.status === 'Approved - scheduling')
      || (documentQueueFilter === 'release' && request.status === 'Ready for release')
    const matchesDocument = requestDocumentFilter === 'all' || (request.documents || []).includes(requestDocumentFilter)
    return matchesQueue && [
    request.id,
    request.resident,
    request.residentCode || '',
    (request.documents || []).join(' '),
    request.status,
    ].some((value) => value.toLowerCase().includes(requestSearch.trim().toLowerCase())) && matchesDocument
  })
  const requestListEntries = (() => {
    if (selectedRequestId) {
      return residentRequests
        .filter((request) => request.id === selectedRequestId)
        .map((request) => ({
          type: 'request',
          request: { ...request, resident: getRequestResidentName(request) },
          key: request.id,
        }))
    }
    const groups = new Map()
    filteredResidentRequests.forEach((request) => {
      const residentCode = String(request.residentCode || '').trim().toLowerCase()
      const residentName = String(request.resident || '').replace(/\s+/g, ' ').trim().toLowerCase()
      const key = residentCode
        ? `code:${residentCode}:name:${residentName || request.id}`
        : `name:${residentName || request.id}`
      groups.set(key, [...(groups.get(key) || []), request])
    })
    return [...groups.entries()].flatMap(([key, requests]) => {
      const newestFirst = requests.sort((first, second) => (
        new Date(second.requestedAt || second.date || 0).getTime()
        - new Date(first.requestedAt || first.date || 0).getTime()
      ))
      return newestFirst.length > 1
      ? [{ type: 'resident', key, requests: newestFirst }]
      : [{ type: 'request', key: newestFirst[0].id, request: newestFirst[0] }]
    })
  })()
  const documentReportCounts = new Map()
  allDocumentRequests.forEach((request) => {
    const requestDate = new Date(request.requestedAt || request.date || '')
    const month = Number.isNaN(requestDate.getTime())
      ? 'Unknown'
      : `${requestDate.getFullYear()}-${String(requestDate.getMonth() + 1).padStart(2, '0')}`
    const status = residentStatusLabels[request.status] || request.status
    const documents = request.documents || []
    documents.forEach((document) => {
      const key = `${month}\u0000${document}\u0000${status}`
      const existing = documentReportCounts.get(key)
      if (existing) existing.count += 1
      else documentReportCounts.set(key, { key, month, document, status, count: 1 })
    })
  })
  const documentReportRows = Array.from(documentReportCounts.values()).sort((first, second) => second.month.localeCompare(first.month) || first.document.localeCompare(second.document) || first.status.localeCompare(second.status))
  const editingRegistrationRequest = registrationRequests.find((request) => request.id === editingRegistrationId)
  const declinedRegistrationRequests = registrationRequests.filter((request) => request.status === 'Declined')
  const certificateProcessingRequestRecord = allDocumentRequests.find((request) => request.id === certificateProcessingRequestId)
  const certificateProcessingRequestGroup = certificateProcessingRequestGroupIds
    .map((id) => allDocumentRequests.find((request) => request.id === id))
    .filter(Boolean)
  const certificateProcessingRequest = certificateProcessingRequestRecord
    ? {
      ...certificateProcessingRequestRecord,
      resident: getRequestResidentName(certificateProcessingRequestRecord),
      ...(certificateProcessingRequestGroup.length > 1 ? {
        documents: [certificateProcessingDocument || certificateProcessingRequestRecord.documents[0]],
        copyCount: certificateProcessingRequestGroup.reduce((total, request) => total + (Number(request.copyCount) || 1), 0),
        processingRequestIds: certificateProcessingRequestGroup.map((request) => request.id),
      } : {}),
    }
    : null
  const residentHistoryRequests = residentAccountRequests
    .filter((request) => ['Completed', 'Released', 'Declined', 'Cancelled'].includes(request.status))
    .sort((first, second) => new Date(second.releasedAt || second.cancelledAt || second.statusHistory?.slice(-1)[0]?.changedAt || second.requestedAt || second.date || 0).getTime()
      - new Date(first.releasedAt || first.cancelledAt || first.statusHistory?.slice(-1)[0]?.changedAt || first.requestedAt || first.date || 0).getTime())
  const selectedResidentHistoryRequest = residentHistoryRequests.find((request) => request.id === selectedResidentHistoryRequestId)
  const getResidentRequestCompletionDate = (request) => request.releasedAt
    || request.cancelledAt
    || request.statusHistory?.slice().reverse().find((entry) => ['Completed', 'Released', 'Declined', 'Cancelled'].includes(entry.status))?.changedAt
    || ''
  const certificateTemplateProcessingRequests = processingTemplateDocument
    ? (() => {
     const candidates = residentRequests.filter((request) => (
      request.status === 'Approved - scheduling'
      && request.documents.includes(processingTemplateDocument)
      && !request.printedDocuments?.[processingTemplateDocument]
      ))
     const groupedRequests = new Map()
     candidates.forEach((request) => {
       const requestDocuments = request.documents || []
       const canCombine = requestDocuments.includes(processingTemplateDocument)
       const documentSetKey = JSON.stringify([...requestDocuments].sort())
       const certificateData = getSubmittedCertificateData(request, processingTemplateDocument)
       const fields = getCertificateTemplateFields(processingTemplateDocument, customCertificateTemplates)
       const dataKey = JSON.stringify(fields.map((field) => [
         field.key,
         String(getCertificateFieldValue(certificateData, field) ?? '').trim(),
       ]))
       const resident = getRequestResidentName(request)
       const groupKey = canCombine
         ? `${resident.replace(/\s+/g, ' ').trim().toLowerCase()}|${documentSetKey}|${dataKey}`
         : request.id
       const existing = groupedRequests.get(groupKey)
       if (existing) {
         existing.processingRequestIds.push(request.id)
         existing.copyCount += Number(request.copyCount) || 1
       } else {
         groupedRequests.set(groupKey, {
           ...request,
           resident,
           processingRequestIds: [request.id],
           copyCount: Number(request.copyCount) || 1,
         })
       }
     })
     return [...groupedRequests.values()]
    })()
    : []
  const requestGroups = Object.values(allDocumentRequests
    .filter((request) => request.status !== 'Approved - scheduling' || request.printCompletedAt)
    .reduce((groups, request) => {
    const residentKey = request.resident.replace(/\s+/g, ' ').trim().toLowerCase()
    if (!groups[residentKey]) groups[residentKey] = { resident: request.resident, residentCode: request.residentCode || '', requests: [] }
    if (!groups[residentKey].residentCode && request.residentCode) groups[residentKey].residentCode = request.residentCode
    groups[residentKey].requests.push(request)
    return groups
  }, {})).sort((first, second) => first.resident.localeCompare(second.resident))
  const historyRequestList = requestGroups.flatMap((group) => group.requests)
    .sort((first, second) => new Date(second.requestedAt || second.date || 0).getTime() - new Date(first.requestedAt || first.date || 0).getTime())
  const selectedHistoryRequest = historyRequestList.find((request) => request.id === selectedHistoryRequestId)
  const historyRequestStats = {
    total: historyRequestList.length,
    processing: historyRequestList.filter((request) => ['New', 'For Verification', 'Returned for edits', 'Under review', 'Approved - scheduling'].includes(request.status)).length,
    ready: historyRequestList.filter((request) => request.status === 'Ready for release').length,
    declined: historyRequestList.filter((request) => request.status === 'Declined').length,
  }
  const statusChronology = ['New', 'Under review', 'Returned for edits', 'Approved - scheduling', 'Ready for release', 'Completed', 'Declined']
  const historyStatusOptions = [...new Set(historyRequestList.map((request) => request.status))]
    .sort((first, second) => {
      const firstOrder = statusChronology.indexOf(first)
      const secondOrder = statusChronology.indexOf(second)
      if (firstOrder === -1 && secondOrder === -1) return first.localeCompare(second)
      if (firstOrder === -1) return 1
      if (secondOrder === -1) return -1
      return firstOrder - secondOrder
    })
  const filteredHistoryRequests = historyRequestList.filter((request) => {
    const matchesStatus = historyStatusFilter === 'all' || request.status === historyStatusFilter
    const matchesSearch = [
      request.id || '',
      request.resident || '',
      request.name || '',
      request.fullName || '',
      request.full_name || '',
      request.residentCode || '',
      request.resident_code || '',
      (request.documents || []).join(' '),
      request.status || '',
    ].some((value) => String(value || '').toLowerCase().includes(historySearch.trim().toLowerCase()))
    return matchesStatus && matchesSearch
  })
  const residentRecordsQuery = residentRecordsSearch.trim().toLowerCase()
  const filteredAdminResidents = adminResidents.filter((resident) => [
    resident.name,
    resident.fullName,
    resident.full_name,
    resident.firstName,
    resident.middleName,
    resident.lastName,
    resident.address,
    resident.code,
    resident.residentCode,
    resident.resident_code,
  ].some((value) => String(value || '').toLowerCase().includes(residentRecordsQuery)))
  const filteredDeclinedRegistrationRequests = declinedRegistrationRequests.filter((request) => [
    request.id,
    request.name,
    request.fullName,
    request.full_name,
    request.address,
    request.assignedResidentCode,
    request.data?.firstName,
    request.data?.middleName,
    request.data?.lastName,
    request.data?.residentCode,
  ].some((value) => String(value || '').toLowerCase().includes(residentRecordsQuery)))
  useEffect(() => {
    const syncCommunityUpdates = (event) => {
      if (event.key !== communityUpdatesStorageKey || !event.newValue) return
      try {
        const savedUpdates = JSON.parse(event.newValue)
        if (!Array.isArray(savedUpdates)) throw new Error('Saved community updates must be a list.')
        if (JSON.stringify(communityRecordsRef.current[communityUpdatesStorageKey]) !== JSON.stringify(savedUpdates)) {
          skipNextDatabaseSaveRef.current = true
          setCommunityUpdates(savedUpdates)
        }
        setCommunityUpdatesError('')
      } catch (error) {
        console.error('Unable to sync community updates from another browser tab.', error)
        setCommunityUpdatesError('Unable to sync updates from another browser tab.')
      }
    }
    window.addEventListener('storage', syncCommunityUpdates)
    return () => window.removeEventListener('storage', syncCommunityUpdates)
  }, [])

  useEffect(() => {
    const syncGcashRecipients = (event) => {
      if (event.key !== gcashRecipientsStorageKey || !event.newValue) return
      try {
        applySharedGcashRecipients({ [gcashRecipientsStorageKey]: JSON.parse(event.newValue) })
      } catch (error) {
        console.error('Unable to sync GCash recipients from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncGcashRecipients)
    return () => window.removeEventListener('storage', syncGcashRecipients)
  }, [applySharedGcashRecipients])

  useEffect(() => {
    const syncCertificateCatalog = (event) => {
      if (!event.newValue || ![
        certificateTemplatesStorageKey,
        enabledCertificateTypesStorageKey,
        documentFeesStorageKey,
      ].includes(event.key)) return
      try {
        applySharedCertificateCatalog({ [event.key]: JSON.parse(event.newValue) })
      } catch (error) {
        console.error('Unable to sync certificate templates from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncCertificateCatalog)
    return () => window.removeEventListener('storage', syncCertificateCatalog)
  }, [applySharedCertificateCatalog])

  useEffect(() => {
    const syncOfficialRecords = (event) => {
      if (!event.newValue) return
      try {
        const savedValue = JSON.parse(event.newValue)
        if (event.key === officialProfilesStorageKey) {
          if (!Array.isArray(savedValue)) throw new Error('Saved official profiles must be a list.')
          if (JSON.stringify(communityRecordsRef.current[officialProfilesStorageKey]) !== JSON.stringify(savedValue)) {
            skipNextDatabaseSaveRef.current = true
            setOfficialProfiles(savedValue)
          }
        } else if (event.key === officialAvailabilityStorageKey) {
          if (!Array.isArray(savedValue)) throw new Error('Saved official schedules must be a list.')
          if (JSON.stringify(communityRecordsRef.current[officialAvailabilityStorageKey]) !== JSON.stringify(savedValue)) {
            skipNextDatabaseSaveRef.current = true
            setOfficialAvailability(savedValue)
          }
        } else if (event.key === officialPhotosStorageKey) {
          if (!savedValue || typeof savedValue !== 'object' || Array.isArray(savedValue)
            || !Object.values(savedValue).every((photo) => typeof photo === 'string')) {
            throw new Error('Saved official photos must be an image map.')
          }
          if (JSON.stringify(communityRecordsRef.current[officialPhotosStorageKey]) !== JSON.stringify(savedValue)) {
            skipNextDatabaseSaveRef.current = true
            setOfficialPhotos(savedValue)
          }
        } else {
          return
        }
      } catch (error) {
        console.error('Unable to sync official information from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncOfficialRecords)
    return () => window.removeEventListener('storage', syncOfficialRecords)
  }, [])

  useEffect(() => {
    if (!isStorageLoaded || (
      !showPublicSidebar
      && !showResidentInboxPage
      && !showResidentCheck
      && !residentToken
    )) return undefined
    const controller = new AbortController()
    let requestPending = false
    const refreshCommunityRecords = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const response = await fetchWithTimeout(PUBLIC_COMMUNITY_API_URL, {
          cache: 'no-store',
          headers: publicCommunityEtagRef.current
            ? { 'X-Public-Data-Match': publicCommunityEtagRef.current }
            : {},
          signal: controller.signal,
        })
        if (response.status === 304) {
          setIsPublicCommunityConnected(true)
          return
        }
        if (!response.ok) throw new Error(`Community refresh failed with status ${response.status}.`)
        const result = await response.json()
        if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
          throw new Error('The server returned invalid community records.')
        }

        publicCommunityEtagRef.current = response.headers.get('X-Public-Data-ETag') || ''
        applySharedCommunityRecords(result.data)
        applySharedCertificateCatalog(result.data)
        applySharedGcashRecipients(result.data)
        if (Object.prototype.hasOwnProperty.call(result.data, barangayContactInformationStorageKey)) {
          const contactInformation = normalizeBarangayContactInformation(result.data[barangayContactInformationStorageKey])
          const currentMatchesDatabase = !isDatabaseConnected
            || !databaseRecordsRef.current
            || JSON.stringify(barangayContactInformation) === JSON.stringify(
              databaseRecordsRef.current[barangayContactInformationStorageKey],
            )
          if (currentMatchesDatabase && JSON.stringify(barangayContactInformation) !== JSON.stringify(contactInformation)) {
            try {
              window.localStorage.setItem(barangayContactInformationStorageKey, JSON.stringify(contactInformation))
            } catch (error) {
              console.error('Unable to cache refreshed barangay contact information.', error)
            }
            if (isDatabaseConnected && databaseRecordsRef.current) {
              databaseRecordsRef.current = {
                ...databaseRecordsRef.current,
                [barangayContactInformationStorageKey]: contactInformation,
              }
            }
            setBarangayContactInformation(contactInformation)
          }
        }
        setIsPublicCommunityConnected(true)
      } catch (error) {
        if (error.name === 'AbortError') return
        setIsPublicCommunityConnected(false)
        console.error('Unable to refresh admin-managed announcements, events, and official details.', error)
      } finally {
        requestPending = false
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshCommunityRecords()
    }
    refreshCommunityRecords()
    const refreshTimer = window.setInterval(refreshCommunityRecords, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshCommunityRecords)
    window.addEventListener('online', refreshCommunityRecords)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshCommunityRecords)
      window.removeEventListener('online', refreshCommunityRecords)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      controller.abort()
    }
  }, [
    applySharedCertificateCatalog,
    applySharedCommunityRecords,
    applySharedGcashRecipients,
    barangayContactInformation,
    isDatabaseConnected,
    isStorageLoaded,
    residentToken,
    showPublicSidebar,
    showResidentCheck,
    showResidentInboxPage,
  ])

  useEffect(() => {
    if (!isStorageLoaded) return
    const submittedPaymentDrafts = residentPaymentDrafts.filter((request) => (
      ['Pending verification', 'Paid'].includes(request.paymentStatus)
      && (request.paymentSubmittedAt || request.paymentProof?.dataUrl || request.paymentProofOrNumber?.trim())
    ))
    if (!submittedPaymentDrafts.length) return

    const migratedRequests = [...residentRequestsRef.current]
    submittedPaymentDrafts.forEach((paymentRequest) => {
      const requestIndex = migratedRequests.findIndex((request) => request.id === paymentRequest.id)
      const submittedRequest = { ...paymentRequest }
      delete submittedRequest.awaitingPaymentSubmission
      delete submittedRequest.paymentDraftedAt
      if (requestIndex < 0) {
        migratedRequests.unshift({
          ...submittedRequest,
          status: submittedRequest.status || 'New',
          statusHistory: submittedRequest.statusHistory?.length
            ? submittedRequest.statusHistory
            : [{ status: 'New', changedAt: submittedRequest.paymentSubmittedAt || submittedRequest.requestedAt || new Date().toISOString() }],
        })
        return
      }

      const existingRequest = migratedRequests[requestIndex]
      if (existingRequest.paymentSubmittedAt) return
      const activity = [...(existingRequest.activity || [])]
      for (const entry of submittedRequest.activity || []) {
        if (!activity.some((currentEntry) => currentEntry.action === entry.action && currentEntry.time === entry.time)) {
          activity.push(entry)
        }
      }
      migratedRequests[requestIndex] = {
        ...existingRequest,
        ...submittedRequest,
        status: existingRequest.status || submittedRequest.status || 'New',
        statusHistory: existingRequest.statusHistory?.length
          ? existingRequest.statusHistory
          : submittedRequest.statusHistory || [],
        activity,
      }
    })

    residentRequestsRef.current = migratedRequests
    residentRequestSyncPauseUntilRef.current = Date.now() + 10000
    setResidentRequests(migratedRequests)
    const migratedIds = new Set(submittedPaymentDrafts.map((request) => request.id))
    setResidentPaymentDrafts((drafts) => drafts.filter((request) => !migratedIds.has(request.id)))
  }, [isStorageLoaded, residentPaymentDrafts])

  useEffect(() => {
    if (!isStorageLoaded || !isDatabaseConnected || !officialBackendToken || !showResidentInboxPage) return undefined
    const controller = new AbortController()
    let requestPending = false
    const refreshResidentRequests = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const response = await fetchWithTimeout(API_URL, {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${officialBackendToken}` },
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Resident updates refresh failed with status ${response.status}.`)
        const result = await response.json()
        if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
          throw new Error('The server returned invalid resident update records.')
        }
        applySharedGcashRecipients(result.data)
        applySharedCertificateCatalog(result.data)

        const remoteRequests = result.data[residentRequestsStorageKey]
        const remoteHistory = result.data[residentHistoryStorageKey]
        if (remoteRequests !== undefined && !Array.isArray(remoteRequests)) {
          throw new Error('Saved resident requests must be a list.')
        }
        if (remoteHistory !== undefined && !Array.isArray(remoteHistory)) {
          throw new Error('Saved resident history must be a list.')
        }
        if (residentRequestSavePendingRef.current > 0 || Date.now() < residentRequestSyncPauseUntilRef.current) return

        const nextRequests = remoteRequests === undefined
          ? residentRequestsRef.current
          : splitMultiDocumentRequests(remoteRequests.map(withRequestStatusHistory), customCertificateTemplates)
        const nextHistory = remoteHistory === undefined ? residentHistoryRef.current : remoteHistory
        const requestsChanged = JSON.stringify(residentRequestsRef.current) !== JSON.stringify(nextRequests)
        const historyChanged = JSON.stringify(residentHistoryRef.current) !== JSON.stringify(nextHistory)
        if (!requestsChanged && !historyChanged) return

        skipNextDatabaseSaveRef.current = true
        residentRequestsRef.current = nextRequests
        residentHistoryRef.current = nextHistory
        if (requestsChanged) setResidentRequests(nextRequests)
        if (historyChanged) setResidentHistory(nextHistory)
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to refresh admin updates for the resident dashboard.', error)
        }
      } finally {
        requestPending = false
      }
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshResidentRequests()
    }
    refreshResidentRequests()
    const refreshTimer = window.setInterval(refreshResidentRequests, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshResidentRequests)
    window.addEventListener('online', refreshResidentRequests)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshResidentRequests)
      window.removeEventListener('online', refreshResidentRequests)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      controller.abort()
    }
  }, [applySharedCertificateCatalog, applySharedGcashRecipients, customCertificateTemplates, isDatabaseConnected, isStorageLoaded, officialBackendToken, residentDashboardSection, showResidentInboxPage])

  useEffect(() => {
    if (!isStorageLoaded || !isDatabaseConnected || !showOfficialDashboard || !officialBackendToken) return undefined
    const controller = new AbortController()
    let requestPending = false
    const refreshAdminRequests = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const response = await fetchWithTimeout(API_URL, {
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${officialBackendToken}`,
            ...(databaseEtagRef.current ? { 'If-None-Match': databaseEtagRef.current } : {}),
          },
          signal: controller.signal,
        })
        if (response.status === 304) return
        if (response.status === 401) {
          setOfficialBackendToken('')
          setIsDatabaseConnected(false)
          setShowOfficialDashboard(false)
          setShowOfficialLogin(true)
          setLoginStatus('Your admin session is no longer valid. Sign in again to reconnect.')
          return
        }
        if (!response.ok) throw new Error(`Admin request refresh failed with status ${response.status}.`)
        const result = await response.json()
        if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
          throw new Error('The server returned invalid admin request records.')
        }
        databaseEtagRef.current = response.headers.get('ETag') || ''
        applySharedCommunityRecords(result.data)
        applySharedCertificateCatalog(result.data)
        applySharedGcashRecipients(result.data)
        applySharedAdminSearchRecords(result.data)
        const remoteRequests = result.data[residentRequestsStorageKey]
        let nextRequests = residentRequestsRef.current
        if (remoteRequests !== undefined) {
          if (!Array.isArray(remoteRequests)) throw new Error('Saved resident requests must be a list.')
          if (residentRequestSavePendingRef.current === 0 && Date.now() >= residentRequestSyncPauseUntilRef.current) {
            nextRequests = splitMultiDocumentRequests(
              remoteRequests.map(withRequestStatusHistory),
              customCertificateTemplates,
            )
          }
        }

        const remoteHistory = result.data[residentHistoryStorageKey]
        if (remoteHistory !== undefined && !Array.isArray(remoteHistory)) {
          throw new Error('Saved resident history must be a list.')
        }
        let nextHistory = residentHistoryRef.current
        if (remoteHistory !== undefined
          && residentRequestSavePendingRef.current === 0
          && Date.now() >= residentRequestSyncPauseUntilRef.current) {
          nextHistory = remoteHistory
        }
        const restoredRequests = restoreUnprintedApprovedRequests(
          nextRequests,
          nextHistory,
        )
        const requestsChanged = JSON.stringify(residentRequestsRef.current) !== JSON.stringify(restoredRequests.requests)
        const historyChanged = JSON.stringify(residentHistoryRef.current) !== JSON.stringify(restoredRequests.history)
        if (requestsChanged || historyChanged) {
          residentRequestsRef.current = restoredRequests.requests
          residentHistoryRef.current = restoredRequests.history
          if (requestsChanged) setResidentRequests(restoredRequests.requests)
          if (historyChanged) setResidentHistory(restoredRequests.history)
          if (databaseRecordsRef.current) {
            databaseRecordsRef.current = {
              ...databaseRecordsRef.current,
              [residentRequestsStorageKey]: restoredRequests.requests,
              [residentHistoryStorageKey]: restoredRequests.history,
            }
          }
        }

        const remotePaymentDrafts = result.data[residentPaymentDraftsStorageKey]
        if (remotePaymentDrafts !== undefined) {
          if (!Array.isArray(remotePaymentDrafts)) throw new Error('Saved resident payment drafts must be a list.')
          const currentDrafts = residentPaymentDraftsRef.current
          const savedDrafts = databaseRecordsRef.current?.[residentPaymentDraftsStorageKey]
          const hasLocalDraftChanges = JSON.stringify(currentDrafts) !== JSON.stringify(savedDrafts)
          const mergedDrafts = new Map(
            [...(hasLocalDraftChanges ? currentDrafts : []), ...remotePaymentDrafts]
              .map((request) => [request.id, request]),
          )
          const nextPaymentDrafts = Array.from(mergedDrafts.values())
          if (JSON.stringify(residentPaymentDraftsRef.current) !== JSON.stringify(nextPaymentDrafts)) {
            residentPaymentDraftsRef.current = nextPaymentDrafts
            setResidentPaymentDrafts(nextPaymentDrafts)
          }
          if (databaseRecordsRef.current) {
            databaseRecordsRef.current = {
              ...databaseRecordsRef.current,
              [residentPaymentDraftsStorageKey]: nextPaymentDrafts,
            }
          }
        }
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to refresh resident submissions in the admin request inbox.', error)
        }
      } finally {
        requestPending = false
      }
    }
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') refreshAdminRequests()
    }
    refreshAdminRequests()
    const refreshTimer = window.setInterval(refreshAdminRequests, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', refreshAdminRequests)
    window.addEventListener('online', refreshAdminRequests)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', refreshAdminRequests)
      window.removeEventListener('online', refreshAdminRequests)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      controller.abort()
    }
  }, [
    applySharedAdminSearchRecords,
    applySharedCertificateCatalog,
    applySharedCommunityRecords,
    applySharedGcashRecipients,
    customCertificateTemplates,
    isDatabaseConnected,
    isStorageLoaded,
    officialBackendToken,
    showOfficialDashboard,
  ])

  useEffect(() => {
    const syncResidentRequests = (event) => {
      if (event.key !== residentRequestsStorageKey || !event.newValue) return
      try {
        const savedRequests = JSON.parse(event.newValue)
        if (!Array.isArray(savedRequests)) throw new Error('Saved resident requests must be a list.')
        const syncedRequests = savedRequests.map(withRequestStatusHistory)
        residentRequestsRef.current = syncedRequests
        setResidentRequests(syncedRequests)
      } catch (error) {
        console.error('Unable to sync resident requests from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncResidentRequests)
    return () => window.removeEventListener('storage', syncResidentRequests)
  }, [])

  useEffect(() => {
    const syncResidentDrafts = (event) => {
      if (event.key !== residentDraftsStorageKey || !event.newValue) return
      try {
        const savedDrafts = JSON.parse(event.newValue)
        if (!Array.isArray(savedDrafts) || !savedDrafts.every((draft) => draft && typeof draft.id === 'string')) {
          throw new Error('Saved resident request drafts must be a list of identified drafts.')
        }
        setResidentDrafts(savedDrafts)
      } catch (error) {
        console.error('Unable to sync resident request drafts from another browser tab.', error)
        setResidentDraftError('Unable to sync saved drafts from another browser tab.')
      }
    }
    window.addEventListener('storage', syncResidentDrafts)
    return () => window.removeEventListener('storage', syncResidentDrafts)
  }, [])

  useEffect(() => {
    const syncResidentPaymentDrafts = (event) => {
      if (event.key !== residentPaymentDraftsStorageKey || !event.newValue) return
      try {
        const savedPaymentDrafts = JSON.parse(event.newValue)
        if (!Array.isArray(savedPaymentDrafts)) throw new Error('Saved resident payment drafts must be a list.')
        residentPaymentDraftsRef.current = savedPaymentDrafts
        setResidentPaymentDrafts(savedPaymentDrafts)
      } catch (error) {
        console.error('Unable to sync resident payment drafts from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncResidentPaymentDrafts)
    return () => window.removeEventListener('storage', syncResidentPaymentDrafts)
  }, [])

  useEffect(() => {
    const syncResidentHistory = (event) => {
      if (event.key !== residentHistoryStorageKey || !event.newValue) return
      try {
        const savedHistory = JSON.parse(event.newValue)
        if (!Array.isArray(savedHistory)) throw new Error('Saved resident history must be a list.')
        residentHistoryRef.current = savedHistory
        setResidentHistory(savedHistory)
      } catch (error) {
        console.error('Unable to sync resident history from another browser tab.', error)
      }
    }
    window.addEventListener('storage', syncResidentHistory)
    return () => window.removeEventListener('storage', syncResidentHistory)
  }, [])

  useEffect(() => {
    const syncIndexedResidentRecords = async (event) => {
      if (event.key !== residentLocalRecordChangeKey || !event.newValue) return
      try {
        const change = JSON.parse(event.newValue)
        if (!residentLocalRecordKeys.includes(change.key)) return
        const savedRecords = await readIndexedResidentRecord(change.key)
        if (!Array.isArray(savedRecords)) throw new Error(`Saved ${change.key} must be a list.`)

        if (change.key === residentRequestsStorageKey) {
          const nextRequests = savedRecords.map(withRequestStatusHistory)
          if (JSON.stringify(residentRequestsRef.current) === JSON.stringify(nextRequests)) return
          skipResidentLocalCacheSaveRef.current.set(change.key, nextRequests)
          residentRequestsRef.current = nextRequests
          setResidentRequests(nextRequests)
        } else if (change.key === residentPaymentDraftsStorageKey) {
          if (JSON.stringify(residentPaymentDraftsRef.current) === JSON.stringify(savedRecords)) return
          skipResidentLocalCacheSaveRef.current.set(change.key, savedRecords)
          residentPaymentDraftsRef.current = savedRecords
          setResidentPaymentDrafts(savedRecords)
        } else if (change.key === residentHistoryStorageKey) {
          if (JSON.stringify(residentHistoryRef.current) === JSON.stringify(savedRecords)) return
          skipResidentLocalCacheSaveRef.current.set(change.key, savedRecords)
          residentHistoryRef.current = savedRecords
          setResidentHistory(savedRecords)
        } else if (change.key === residentDraftsStorageKey) {
          if (JSON.stringify(residentDraftsRef.current) === JSON.stringify(savedRecords)) return
          skipResidentLocalCacheSaveRef.current.set(change.key, savedRecords)
          residentDraftsRef.current = savedRecords
          setResidentDrafts(savedRecords)
        }
      } catch (error) {
        console.error('Unable to sync resident records from another browser tab.', error)
        if (event.newValue.includes(residentDraftsStorageKey)) {
          setResidentDraftError('Unable to sync saved drafts from another browser tab.')
        }
      }
    }
    window.addEventListener('storage', syncIndexedResidentRecords)
    return () => window.removeEventListener('storage', syncIndexedResidentRecords)
  }, [])

  useEffect(() => {
    if (!isStorageLoaded || !residentToken || !residentName.code || registrationCommunityOnlyAccess) {
      residentRequestSyncSnapshotRef.current = new Map()
      return undefined
    }

    const controller = new AbortController()
    const residentAccount = {
      code: residentName.code,
      firstName: residentName.firstName,
      middleName: residentName.middleName,
      lastName: residentName.lastName,
      suffix: residentName.suffix,
    }
    let requestPending = false

    const synchronizeRequests = async () => {
      if (document.visibilityState !== 'visible') return
      if (requestPending) return
      requestPending = true
      try {
        const currentOwnedRequests = residentRequestsRef.current.filter((request) => (
          request?.id && residentRecordMatchesAccount(request, residentAccount)
        ))
        const seenRequestIds = new Set()
        const hasDuplicateRequestIds = currentOwnedRequests.some((request) => {
          if (seenRequestIds.has(request.id)) return true
          seenRequestIds.add(request.id)
          return false
        })
        let remoteRequestsBeforeSubmit = []
        if (hasDuplicateRequestIds) {
          const response = await fetchWithTimeout(RESIDENT_REQUEST_SYNC_URL, {
            method: 'GET',
            cache: 'no-store',
            headers: { Authorization: `Bearer ${residentToken}` },
            signal: controller.signal,
          })
          const result = await readJsonResponse(response, 'Resident request sync')
          if (!response.ok || !result.success || !result.data
            || !Array.isArray(result.data.requests)
            || !result.data.requests.every((request) => request && typeof request.id === 'string')) {
            throw new Error(result.message || `Resident request sync failed with status ${response.status}.`)
          }
          remoteRequestsBeforeSubmit = result.data.requests
        }
        const ownedRequests = resolveResidentRequestIdCollisions(currentOwnedRequests, remoteRequestsBeforeSubmit)
        const requestsToSubmit = ownedRequests.filter((request) => (
          residentRequestSyncSnapshotRef.current.get(request.id) !== JSON.stringify(request)
        ))
        const shouldSubmit = requestsToSubmit.length > 0
        const response = await fetchWithTimeout(RESIDENT_REQUEST_SYNC_URL, {
          method: shouldSubmit ? 'POST' : 'GET',
          cache: 'no-store',
          headers: {
            Authorization: `Bearer ${residentToken}`,
            ...(shouldSubmit ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(shouldSubmit ? { body: JSON.stringify({ requests: requestsToSubmit }) } : {}),
          signal: controller.signal,
        })
        const result = await readJsonResponse(response, 'Resident request sync')
        if (!response.ok || !result.success || !result.data
          || !Array.isArray(result.data.requests) || !Array.isArray(result.data.history)
          || !result.data.requests.every((request) => request && typeof request.id === 'string')
          || !result.data.history.every((request) => request && typeof request.id === 'string')) {
          throw new Error(result.message || `Resident request sync failed with status ${response.status}.`)
        }

        const archivedIds = new Set(result.data.history.map((request) => request.id))
        const remoteRequests = splitMultiDocumentRequests(
          uniqueResidentRequestsById(result.data.requests).map(withRequestStatusHistory),
          customCertificateTemplates,
        )
        const nextRequests = mergeResidentSyncRecords(
          residentRequestsRef.current,
          remoteRequests,
          residentAccount,
          archivedIds,
        )
        const nextHistory = mergeResidentSyncRecords(
          residentHistoryRef.current,
          result.data.history,
          residentAccount,
        )

        if (JSON.stringify(residentRequestsRef.current) !== JSON.stringify(nextRequests)) {
          residentRequestsRef.current = nextRequests
          setResidentRequests(nextRequests)
        }
        if (JSON.stringify(residentHistoryRef.current) !== JSON.stringify(nextHistory)) {
          residentHistoryRef.current = nextHistory
          setResidentHistory(nextHistory)
        }

        const serverRequestIds = new Set(result.data.requests.map((request) => request.id))
        const serverSubmissionIds = new Set(result.data.requests.map((request) => request.submissionId || request.id))
        residentRequestSyncSnapshotRef.current = new Map(
          nextRequests
            .filter((request) => (
              residentRecordMatchesAccount(request, residentAccount)
              && (serverRequestIds.has(request.id) || serverSubmissionIds.has(request.submissionId || request.id))
            ))
            .map((request) => [request.id, JSON.stringify(request)]),
        )
        setResidentDatabaseSyncError('')
        setIsResidentDatabaseConnected(true)
      } catch (error) {
        if (error.name !== 'AbortError') {
          console.error('Unable to synchronize resident requests with the shared database.', error)
          setResidentDatabaseSyncError(error.message || 'Resident requests could not be synchronized.')
          setIsResidentDatabaseConnected(false)
        }
      } finally {
        requestPending = false
      }
    }

    const synchronizeWhenVisible = () => {
      if (document.visibilityState === 'visible') synchronizeRequests()
    }
    synchronizeRequests()
    const refreshTimer = window.setInterval(synchronizeRequests, DATABASE_REFRESH_INTERVAL_MS)
    window.addEventListener('focus', synchronizeRequests)
    window.addEventListener('online', synchronizeRequests)
    document.addEventListener('visibilitychange', synchronizeWhenVisible)
    return () => {
      window.clearInterval(refreshTimer)
      window.removeEventListener('focus', synchronizeRequests)
      window.removeEventListener('online', synchronizeRequests)
      document.removeEventListener('visibilitychange', synchronizeWhenVisible)
      controller.abort()
    }
  }, [
    customCertificateTemplates,
    isStorageLoaded,
    registrationCommunityOnlyAccess,
    residentName.code,
    residentName.firstName,
    residentName.lastName,
    residentName.middleName,
    residentName.suffix,
    residentRequests,
    residentToken,
  ])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (shouldSkipResidentLocalCacheSave(residentRequestsStorageKey, residentRequests)) return
    saveResidentLocalRecord(residentRequestsStorageKey, residentRequests).catch((error) => {
      console.error('Unable to save resident requests in browser storage.', error)
      setDatabaseSaveError(`Resident requests could not be saved locally: ${error.message}`)
      setDatabaseSaveStatus('error')
    })
  }, [isStorageLoaded, residentRequests])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(residentNotificationReadStateStorageKey, JSON.stringify(residentNotificationReadState))
    } catch (error) {
      console.error('Unable to save resident notification read status.', error)
    }
  }, [isStorageLoaded, residentNotificationReadState])

  useEffect(() => {
    try {
      window.localStorage.setItem(adminNavigationReadStateStorageKey, JSON.stringify(adminNavigationReadState))
    } catch (error) {
      console.error('Unable to save admin navigation read status.', error)
    }
  }, [adminNavigationReadState])

  useEffect(() => {
    if (!isStorageLoaded || !isDatabaseConnected) return
    residentRequestSavePendingRef.current += 1
    const saveResidentRequests = async () => {
      try {
        setDatabaseSaveStatus('saving')
        await queueDatabaseRecords(databaseSaveQueueRef, { [residentRequestsStorageKey]: residentRequests }, officialBackendToken)
        setDatabaseSaveError('')
        setDatabaseSaveStatus('saved')
      } catch (error) {
        console.error('Unable to save resident document requests to the database.', error)
        setDatabaseSaveError(error.message || 'Resident document requests could not be saved.')
        setDatabaseSaveStatus('error')
        setIsDatabaseConnected(false)
      } finally {
        residentRequestSavePendingRef.current -= 1
      }
    }

    residentRequestSaveQueueRef.current = residentRequestSaveQueueRef.current.then(saveResidentRequests)
  }, [isDatabaseConnected, isStorageLoaded, officialBackendToken, residentRequests])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (shouldSkipResidentLocalCacheSave(residentPaymentDraftsStorageKey, residentPaymentDrafts)) return
    saveResidentLocalRecord(residentPaymentDraftsStorageKey, residentPaymentDrafts).catch((error) => {
      console.error('Unable to save resident payment drafts in browser storage.', error)
      setDatabaseSaveError(`Payment requests could not be saved locally: ${error.message}`)
      setDatabaseSaveStatus('error')
    })
  }, [isStorageLoaded, residentPaymentDrafts])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(residentRecordsStorageKey, JSON.stringify(adminResidents))
    } catch (error) {
      console.error('Unable to save resident records in browser storage.', error)
    }
  }, [adminResidents, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (shouldSkipResidentLocalCacheSave(residentHistoryStorageKey, residentHistory)) return
    saveResidentLocalRecord(residentHistoryStorageKey, residentHistory).catch((error) => {
      console.error('Unable to save resident history in browser storage.', error)
      setDatabaseSaveError(`Request history could not be saved locally: ${error.message}`)
      setDatabaseSaveStatus('error')
    })
  }, [isStorageLoaded, residentHistory])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(archivedResidentsStorageKey, JSON.stringify(archivedResidents))
    } catch (error) {
      console.error('Unable to save archived residents in browser storage.', error)
    }
  }, [archivedResidents, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(issuedDocumentsStorageKey, JSON.stringify(issuedDocuments))
    } catch (error) {
      console.error('Unable to save issued documents in browser storage.', error)
    }
  }, [issuedDocuments, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    if (shouldSkipResidentLocalCacheSave(residentDraftsStorageKey, residentDrafts)) return
    saveResidentLocalRecord(residentDraftsStorageKey, residentDrafts)
      .then(() => setResidentDraftError(''))
      .catch((error) => {
      console.error('Unable to save resident request drafts in browser storage.', error)
      setResidentDraftError('Your draft could not be saved to this browser. Check available storage space and try again.')
    })
  }, [isStorageLoaded, residentDrafts])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(enabledCertificateTypesStorageKey, JSON.stringify(enabledCertificateTypes))
    } catch (error) {
      console.error('Unable to save certificate template settings in browser storage.', error)
    }
  }, [enabledCertificateTypes, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(certificateTemplatesStorageKey, JSON.stringify(customCertificateTemplates))
    } catch (error) {
      console.error('Unable to cache custom certificate templates in browser storage.', error)
    }
  }, [customCertificateTemplates, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    saveLocalRegistrationRequests(registrationRequests)
      .then(({ localStorageSaved }) => {
        if (!localStorageSaved) {
          console.warn('Registration evidence is saved in IndexedDB because the browser cache is full.')
        }
      })
      .catch((error) => console.error('Unable to save registration requests in browser storage.', error))
  }, [isStorageLoaded, registrationRequests])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(residentCodeRecoveryRequestsStorageKey, JSON.stringify(residentCodeRecoveryRequests))
    } catch (error) {
      console.error('Unable to save resident code recovery requests in browser storage.', error)
    }
  }, [isStorageLoaded, residentCodeRecoveryRequests])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(residentProfileUpdateRequestsStorageKey, JSON.stringify(residentProfileUpdateRequests))
    } catch (error) {
      console.error('Unable to save resident profile update requests in browser storage.', error)
    }
  }, [isStorageLoaded, residentProfileUpdateRequests])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(documentFeesStorageKey, JSON.stringify(documentFees))
      window.localStorage.setItem(documentFeesDefaultsVersionStorageKey, String(documentFeesDefaultsVersion))
    } catch (error) {
      console.error('Unable to save document fees in browser storage.', error)
    }
  }, [documentFees, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(officialProfilesStorageKey, JSON.stringify(officialProfiles))
    } catch (error) {
      console.error('Unable to save official profiles in browser storage.', error)
    }
  }, [isStorageLoaded, officialProfiles])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(officialAvailabilityStorageKey, JSON.stringify(officialAvailability))
    } catch (error) {
      console.error('Unable to save official availability in browser storage.', error)
    }
  }, [isStorageLoaded, officialAvailability])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(gcashRecipientsStorageKey, JSON.stringify(gcashRecipients))
    } catch (error) {
      console.error('Unable to save GCash recipients in browser storage.', error)
    }
  }, [gcashRecipients, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded) return
    try {
      window.localStorage.setItem(adminPreferencesStorageKey, JSON.stringify({ darkMode, fontSize, autoLogoutMinutes }))
    } catch (error) {
      console.error('Unable to save admin preferences in browser storage.', error)
    }
  }, [autoLogoutMinutes, darkMode, fontSize, isStorageLoaded])

  useEffect(() => {
    if (!isStorageLoaded || !isDatabaseConnected) return
    if (skipNextDatabaseSaveRef.current) {
      skipNextDatabaseSaveRef.current = false
      return
    }

    const records = {
      [communityUpdatesStorageKey]: communityUpdates,
      [barangayContactInformationStorageKey]: barangayContactInformation,
      [residentPaymentDraftsStorageKey]: residentPaymentDrafts,
      [residentDraftsStorageKey]: residentDrafts,
      [residentRecordsStorageKey]: adminResidents,
      [residentHistoryStorageKey]: residentHistory,
      [archivedResidentsStorageKey]: archivedResidents,
      [issuedDocumentsStorageKey]: issuedDocuments,
      [certificateTemplatesStorageKey]: customCertificateTemplates,
      [enabledCertificateTypesStorageKey]: enabledCertificateTypes,
      [documentFeesDefaultsVersionStorageKey]: documentFeesDefaultsVersion,
      [officialAvailabilityStorageKey]: officialAvailability,
      [registrationRequestsStorageKey]: registrationRequests,
      [residentCodeRecoveryRequestsStorageKey]: residentCodeRecoveryRequests,
      [residentProfileUpdateRequestsStorageKey]: residentProfileUpdateRequests,
      [documentFeesStorageKey]: documentFees,
      [adminPreferencesStorageKey]: { darkMode, fontSize, autoLogoutMinutes },
      [officialProfilesStorageKey]: officialProfiles,
      [officialPhotosStorageKey]: officialPhotos,
      [gcashRecipientsStorageKey]: gcashRecipients,
    }
    const changedRecords = Object.fromEntries(Object.entries(records).filter(([key, value]) => (
      JSON.stringify(databaseRecordsRef.current?.[key]) !== JSON.stringify(value)
    )))
    if (!Object.keys(changedRecords).length) return

    const saveTimer = window.setTimeout(() => {
      setDatabaseSaveStatus('saving')
      queueDatabaseRecords(databaseSaveQueueRef, changedRecords, officialBackendToken)
        .then(() => {
          databaseRecordsRef.current = { ...databaseRecordsRef.current, ...changedRecords }
          setDatabaseSaveError('')
          setDatabaseSaveStatus('saved')
        })
        .catch((error) => {
          console.error('Database saving error:', error)
          setDatabaseSaveError(error.message || 'The database did not save the latest changes.')
          setDatabaseSaveStatus('error')
          setIsDatabaseConnected(false)
        })
    }, 350)

    return () => window.clearTimeout(saveTimer)
  }, [
    isStorageLoaded,
    isDatabaseConnected,
    officialBackendToken,
    communityUpdates,
    barangayContactInformation,
    residentPaymentDrafts,
    residentDrafts,
    adminResidents,
    residentHistory,
    archivedResidents,
    issuedDocuments,
    customCertificateTemplates,
    enabledCertificateTypes,
    officialAvailability,
    registrationRequests,
    residentCodeRecoveryRequests,
    residentProfileUpdateRequests,
    documentFees,
    darkMode,
    fontSize,
    autoLogoutMinutes,
    officialProfiles,
    officialPhotos,
    gcashRecipients,
  ])

  const persistCommunityUpdates = (updates) => {
    try {
      window.localStorage.setItem(communityUpdatesStorageKey, JSON.stringify(updates))
      setCommunityUpdates(updates)
      setCommunityUpdatesError('')
      return true
    } catch (error) {
      console.error('Unable to save community updates in browser storage.', error)
      setCommunityUpdatesError('Unable to save updates in this browser. Check available storage and try again.')
      return false
    }
  }

  const saveBarangayContactInformation = () => {
    const updatedInformation = normalizeBarangayContactInformation(
      barangayContactInformationDraft ?? barangayContactInformation,
    )
    try {
      window.localStorage.setItem(barangayContactInformationStorageKey, JSON.stringify(updatedInformation))
      setBarangayContactInformation(updatedInformation)
      setBarangayContactInformationDraft(null)
      setBarangayContactInformationError('')
      setBarangayContactInformationStatus('Contact information saved.')
    } catch (error) {
      console.error('Unable to save barangay contact information in browser storage.', error)
      setBarangayContactInformationError('Unable to save contact information in this browser.')
      setBarangayContactInformationStatus('')
    }
  }

  const chooseRole = (role) => {
    setSelectedRole(role)
    if (role === 'resident') {
      setShowOfficials(false)
      setShowResidentCheck(false)
      setShowResidentOptions(true)
      setShowResidentInboxPage(false)
      setInboxAccessMode(false)
      setShowRegistrationForm(false)
      setRegistrationSubmitted(false)
      setReturnToRegistrationCommunity(false)
      setSubmittedRegistrationId('')
      setShowOfficialLogin(false)
      setShowOfficialDashboard(false)
      setShowDocumentOptions(false)
      setShowRequestForm(false)
      setShowReview(false)
      setRequestSubmitted(false)
      setReturnToResidentDashboardAfterRequest(false)
      setResidentStatus('')
    }
    if (role === 'official') {
      setShowOfficials(false)
      setShowResidentCheck(false)
      setShowOfficialLogin(true)
      setShowOfficialDashboard(false)
      setLoginStatus('')
    }
  }

  const openRegistrationCommunity = (notice, residentCode = '') => {
    setResidentName((currentName) => residentCode
      ? { ...currentName, code: residentCode }
      : currentName)
    resetResidentSyncConnection()
    setResidentToken('')
    setAuthenticatedResidentProfile(null)
    setRegistrationCommunityOnlyAccess(true)
    setReturnToRegistrationCommunity(false)
    setRegistrationReferenceNotice(notice)
    setResidentDashboardSection('community')
    setSelectedInboxRequestId(null)
    setSelectedResidentHistoryRequestId(null)
    setNotificationsOpen(false)
    setProfileOpen(false)
    setShowResidentOptions(false)
    setShowResidentInboxPage(true)
    setShowResidentCheck(false)
    setShowDocumentOptions(false)
    setResidentStatus('registered')
  }

  const checkRegistrationReference = async (enteredCode) => {
    let availableRequests = registrationRequests
    let refreshFailed = false
    if (/^(DB-)?REG-/i.test(enteredCode)) {
      try {
        const response = await fetchWithTimeout(API_URL, { cache: 'no-store' })
        if (!response.ok) throw new Error(`Registration status refresh failed with status ${response.status}.`)
        const result = await response.json()
        if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
          throw new Error('The registration service returned invalid status data.')
        }
        const sharedRequests = result.data[registrationRequestsStorageKey] ?? []
        if (!Array.isArray(sharedRequests)) throw new Error('Saved registration requests must be a list.')
        availableRequests = mergeRegistrationRequestLists(sharedRequests, registrationRequests)
        setRegistrationRequests(availableRequests)
      } catch (error) {
        refreshFailed = true
        console.error('Unable to refresh the application status before resident sign-in.', error)
      }
    }

    const request = availableRequests.find((candidate) => (
      (candidate.id?.toUpperCase() === enteredCode || String(candidate.backendRegistrationId || '') === enteredCode)
      && residentNameMatches(candidate.name, residentName, candidate.data)
    ))
    if (refreshFailed && (isDatabaseConnected || !request)) {
      setResidentLoginError('Unable to verify this application reference right now. Please try again when the registration service is available.')
      return true
    }
    if (!request) return false

    setShowDocumentOptions(false)
    setShowResidentInboxPage(false)
    setRegistrationReferenceNotice(null)
    if (request.status === 'Deleted') {
      if (request.referenceNoticeDismissedAt) {
        setResidentStatus('registration-reference-used')
        return true
      }
      setRegistrationReferenceNotice({
        kind: 'one-time',
        requestId: request.id,
        status: request.status,
        message: request.deletionReason || 'This application was removed. Please visit the barangay office if you need more information.',
      })
      setResidentStatus('registration-reference-notice')
      return true
    }

    if (request.status === 'Declined') {
      if (request.referenceNoticeDismissedAt) {
        setResidentStatus('registration-reference-used')
        return true
      }
      openRegistrationCommunity({
        kind: 'declined',
        requestId: request.id,
        status: request.status,
        message: request.rejectionReason || 'Sorry, your registration was not approved. Please contact the barangay office for more information.',
      })
      return true
    }

    if (request.status !== 'Approved') {
      const isPaused = request.referenceAccessStatus === 'Paused'
      openRegistrationCommunity({
        kind: isPaused ? 'paused' : 'pending',
        requestId: request.id,
        status: request.status,
        message: isPaused
          ? request.referenceAccessNote || 'Your application is paused. Please follow the barangay office’s instructions.'
          : 'Your application is still under review. You can visit Community while you wait; other resident services will be available after approval.',
      })
      return true
    }

    const resident = adminResidents.find((candidate) => (
      normalizeResidentCode(candidate.code) === normalizeResidentCode(request.assignedResidentCode)
    ))
    if (!request.assignedResidentCode || resident?.recordStatus === 'inactive') {
      setResidentStatus('not-found')
      return true
    }

    openRegistrationCommunity({
      kind: 'approved',
      requestId: request.id,
      status: request.status,
      code: request.assignedResidentCode,
      message: 'Your registration has been approved. Your assigned resident code is shown below.',
    })
    return true
  }

  const acknowledgeRegistrationReferenceNotice = async () => {
    if (!registrationReferenceNotice?.requestId) return
    const closesDeclinedAccount = registrationReferenceNotice.kind === 'declined'
    const dismissedAt = new Date().toISOString()
    const nextRequests = registrationRequests.map((request) => request.id === registrationReferenceNotice.requestId
      ? { ...request, referenceNoticeDismissedAt: dismissedAt, updatedAt: dismissedAt }
      : request)
    try {
      const localStorageResult = await saveLocalRegistrationRequests(nextRequests)
      if (isDatabaseConnected) {
        await queueDatabaseRecords(databaseSaveQueueRef, { [registrationRequestsStorageKey]: nextRequests }, officialBackendToken)
      }
      setRegistrationRequests(nextRequests)
      setRegistrationReferenceNotice(null)
      setResidentName((currentName) => ({ ...currentName, code: '' }))
      setResidentStatus('registration-reference-used')
      if (closesDeclinedAccount) {
        setRegistrationCommunityOnlyAccess(false)
        setShowResidentInboxPage(false)
        setShowResidentCheck(true)
        setInboxAccessMode(false)
        setShowDocumentOptions(false)
        resetResidentSyncConnection()
        setResidentToken('')
        setAuthenticatedResidentProfile(null)
        setSelectedInboxRequestId(null)
      }
      setResidentLoginError(isDatabaseConnected
        ? ''
        : localStorageResult.localStorageSaved
          ? 'This one-time notice was saved on this browser only because the shared database is unavailable.'
          : 'This one-time notice was saved in local device storage because the browser cache is full and the shared database is unavailable.')
    } catch (error) {
      console.error('Unable to record the one-time registration notice.', error)
      setResidentLoginError('The notice could not be saved, so this application reference has not been closed. Please try again.')
    }
  }

  const returnApprovedReferenceToLogin = () => {
    setRegistrationReferenceNotice(null)
    setRegistrationCommunityOnlyAccess(false)
    setShowResidentInboxPage(false)
    setShowResidentCheck(true)
    setShowResidentOptions(false)
    setShowDocumentOptions(false)
    setInboxAccessMode(false)
    resetResidentSyncConnection()
    setResidentToken('')
    setAuthenticatedResidentProfile(null)
    setResidentName((currentName) => ({ ...currentName, code: '' }))
    setSelectedInboxRequestId(null)
    setSelectedResidentHistoryRequestId(null)
    setResidentStatus('')
    setResidentLoginError('')
  }

  const openResidentDashboard = (profile, token = '') => {
    resetResidentSyncConnection()
    setResidentToken(token)
    setAuthenticatedResidentProfile(profile)
    setRegistrationCommunityOnlyAccess(false)
    setRegistrationReferenceNotice(null)
    setSelectedPaymentRequestIds([])
    setPaymentBatchOpen(false)
    setWalkInPaymentNoticeOpen(false)
    setPaymentProof(null)
    setPaymentProofOrNumber('')
    setPaymentMethod('')
    setPaymentProofError('')
    setPaymentSaveConfirmation(null)
    setResidentName({
      firstName: profile.first_name || '',
      middleName: profile.middle_name || '',
      lastName: profile.last_name || '',
      suffix: profile.suffix || '',
      code: profile.resident_code,
    })
    setResidentDashboardSection('community')
    setSelectedInboxRequestId(null)
    setSelectedResidentHistoryRequestId(null)
    setNotificationsOpen(false)
    setProfileOpen(false)
    setResidentStatus('registered')
    setShowResidentInboxPage(true)
    setShowResidentCheck(false)
    setShowDocumentOptions(false)
  }

  const findLocallyApprovedResident = (enteredCode) => {
    const registration = registrationRequests.find((request) => (
      request.status === 'Approved'
      && !request.backendRegistrationId
      && normalizeResidentCode(request.assignedResidentCode) === normalizeResidentCode(enteredCode)
      && residentNameMatches(request.name, residentName, request.data)
    ))
    if (!registration) return null

    const resident = adminResidents.find((candidate) => (
      candidate.recordStatus !== 'inactive'
      && normalizeResidentCode(candidate.code) === normalizeResidentCode(enteredCode)
      && residentNameMatches(candidate.name, residentName, {
        firstName: candidate.firstName || registration.data?.firstName,
        middleName: candidate.middleName || registration.data?.middleName,
        lastName: candidate.lastName || registration.data?.lastName,
        suffix: candidate.suffix || registration.data?.suffix,
      })
    ))
    if (!resident) return null

    const nameParts = residentNameFieldsFromFullName(resident.name || registration.data?.fullName || registration.name)
    return {
      first_name: resident.firstName || registration.data?.firstName || nameParts.firstName,
      middle_name: resident.middleName || registration.data?.middleName || nameParts.middleName,
      last_name: resident.lastName || registration.data?.lastName || nameParts.lastName,
      suffix: resident.suffix || registration.data?.suffix || nameParts.suffix,
      full_name: resident.name,
      resident_code: resident.code,
    }
  }

  const checkResident = async (event) => {
    event.preventDefault()
    setResidentLoginError('')

    let enteredCode = residentName.code.trim().toUpperCase()

    const registrationReferenceResult = await checkRegistrationReference(enteredCode)
    if (registrationReferenceResult === true) return
    if (typeof registrationReferenceResult === 'string') {
      enteredCode = registrationReferenceResult.trim().toUpperCase()
      setResidentName((currentName) => ({ ...currentName, code: enteredCode }))
    }

    if (!enteredCode) {
      setResidentStatus('not-found')
      setShowDocumentOptions(false)
      return
    }

    setShowDocumentOptions(false)
    const localResident = import.meta.env.DEV ? findLocallyApprovedResident(enteredCode) : null
    if (localResident) {
      openResidentDashboard(localResident)
      return
    }

    try {
      const loginResponse = await fetch(`${BACKEND_API_URL}/resident-login.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          first_name: residentName.firstName.trim(),
          middle_name: residentName.middleName.trim(),
          last_name: residentName.lastName.trim(),
          suffix: residentName.suffix.trim(),
          resident_code: enteredCode,
        }),
      })

      const loginResult = await readJsonResponse(loginResponse, 'Resident login')

      if (!loginResponse.ok || !loginResult.success || !loginResult.token) {
        if (import.meta.env.DEV && loginResponse.status === 401) {
          const localFallback = findLocallyApprovedResident(enteredCode)
          if (localFallback) {
            openResidentDashboard(localFallback)
            return
          }
          resetResidentSyncConnection()
          setResidentToken('')
          setAuthenticatedResidentProfile(null)
          setResidentStatus('not-found')
          setShowDocumentOptions(false)
          return
        }
        throw new Error(loginResult.message || 'Resident login failed.')
      }

      const profileResponse = await fetch(`${BACKEND_API_URL}/resident-profile.php`, {
        headers: {
          Authorization: `Bearer ${loginResult.token}`,
        },
      })

      const profileResult = await readJsonResponse(profileResponse, 'Resident profile')

      if (!profileResponse.ok || !profileResult.success || !profileResult.data) {
        throw new Error(profileResult.message || 'Unable to retrieve resident profile.')
      }

      const profile = profileResult.data

      const profileName = {
        firstName: profile.first_name || '',
        middleName: profile.middle_name || '',
        lastName: profile.last_name || '',
        suffix: profile.suffix || '',
      }

      const matchesName = residentNameMatches(
        profile.full_name,
        residentName,
        profileName
      )

      if (!matchesName || normalizeResidentCode(profile.resident_code) !== normalizeResidentCode(enteredCode)) {
        resetResidentSyncConnection()
        setResidentToken('')
        setAuthenticatedResidentProfile(null)
        setResidentStatus('not-found')
        return
      }

      openResidentDashboard(profile, loginResult.token)
    } catch (error) {
      const localFallback = import.meta.env.DEV ? findLocallyApprovedResident(enteredCode) : null
      if (localFallback && error instanceof TypeError) {
        openResidentDashboard(localFallback)
        return
      }
      console.error('Resident login error:', error)
      resetResidentSyncConnection()
      setResidentToken('')
      setAuthenticatedResidentProfile(null)
      setResidentStatus('service-error')
      setResidentLoginError(
        error instanceof TypeError
          ? import.meta.env.DEV
            ? 'Cannot connect to the resident login API. Start MySQL in Laragon and run start-local-system.cmd.'
            : 'Cannot connect to the online resident service. Check your connection and try again.'
          : error instanceof Error
            ? `Resident login could not be completed: ${error.message}`
            : 'Resident login could not be completed. Check the local API and database.'
      )
      setShowDocumentOptions(false)
    }
  }

  const returnHome = () => {
    setShowOfficials(false)
    setShowResidentCheck(false)
    setShowResidentOptions(false)
    setShowResidentInboxPage(false)
    setSelectedInboxRequestId(null)
    setSelectedResidentHistoryRequestId(null)
    setResidentDashboardSection('community')
    setResidentCommunityTab('announcements')
    activeResidentDraftIdRef.current = null
    setInboxAccessMode(false)
    setShowRegistrationForm(false)
    setRegistrationSubmitted(false)
    setReturnToRegistrationCommunity(false)
    setSubmittedRegistrationId('')
    setShowOfficialLogin(false)
    setShowOfficialDashboard(false)
    resetResidentSyncConnection()
    setResidentToken('')
    setAuthenticatedResidentProfile(null)
    setResidentName({ firstName: '', middleName: '', lastName: '', suffix: '', code: '' })
    setSelectedDocuments([])
    setActiveRequestDocument('')
    setResidentStatus('')
    setRegistrationReferenceNotice(null)
    setRegistrationCommunityOnlyAccess(false)
    setShowDocumentOptions(false)
    setShowRequestForm(false)
    setShowReview(false)
    setRequestSubmitted(false)
    setReturnToResidentDashboardAfterRequest(false)
    setPersonalDetails({ address: '', contactNumber: '', birthDate: '', purpose: '' })
    setPersonalDetailsByDocument({})
    setDocumentCopyCounts({})
    replaceRequirementPhotos({})
    setRequirementPhotoLoading({})
    setRequirementPhotoError('')
    setOfficialCredentials({ username: '', password: '' })
    setLoginStatus('')
    setSelectedRequestId(null)
    setShowDeclineForm(false)
    setDeclineReason('')
    setInvalidRequirements([])
    setShowPublicSidebar(false)
    setShowAboutPage(false)
    setAboutFromDashboard(false)
    setAboutFromResidentDashboard(false)
    setShowResidentInbox(false)
  }

  const openAboutPage = () => {
    setAboutFromResidentDashboard(showResidentInboxPage)
    setAboutFromDashboard(showOfficialDashboard || showResidentInboxPage)
    setNotificationsOpen(false)
    setProfileOpen(false)
    setShowAboutPage(true)
  }

  const closeAboutPage = () => {
    if (aboutFromDashboard) {
      setShowAboutPage(false)
      setAboutFromDashboard(false)
      setAboutFromResidentDashboard(false)
      return
    }
    returnHome()
  }

  const chooseResidentPath = (path) => {
    const isDashboardRequest = path === 'request' && showResidentInboxPage
    setShowResidentOptions(false)
    if (path === 'request') {
      setRegistrationCommunityOnlyAccess(false)
      setRegistrationReferenceNotice(null)
      if (isDashboardRequest) {
        setSelectedInboxRequestId(null)
        setSelectedResidentHistoryRequestId(null)
        setResidentDashboardSection('request-documents')
        return
      }
      setResidentName((currentName) => ({ ...currentName, suffix: '' }))
      setShowResidentInboxPage(false)
      setNotificationsOpen(false)
      setProfileOpen(false)
      setSelectedInboxRequestId(null)
      setInboxAccessMode(false)
      setShowResidentCheck(true)
      setShowRegistrationForm(false)
      setShowDocumentOptions(isDashboardRequest)
      setShowRequestForm(false)
      setShowReview(false)
      setRequestSubmitted(false)
      activeResidentDraftIdRef.current = null
      setSelectedDocuments([])
      setDocumentCopyCounts({})
      replaceRequirementPhotos({})
      setRequirementPhotoLoading({})
      setRequirementPhotoError('')
      setPersonalDetails({ address: '', contactNumber: '', birthDate: '', purpose: '' })
      setReturnToResidentDashboardAfterRequest(isDashboardRequest)
    } else if (path === 'inbox') {
      setResidentName((currentName) => ({ ...currentName, suffix: '' }))
      setRegistrationCommunityOnlyAccess(false)
      setRegistrationReferenceNotice(null)
      setInboxAccessMode(true)
      setShowResidentCheck(true)
      setShowRegistrationForm(false)
      setResidentStatus('')
      setShowDocumentOptions(false)
      setShowResidentInboxPage(false)
      setSelectedInboxRequestId(null)
    } else {
      setInboxAccessMode(false)
      setShowResidentCheck(false)
      setRegistrationStorageWarning('')
      setShowRegistrationForm(true)
    }
  }

  const continueDashboardRequest = (guideReviewed = residentDocumentGuideReviewed) => {
    if (!selectedDocuments.length || !guideReviewed) return
    setActiveRequestDocument(selectedDocuments[0])
    setPersonalDetailsByDocument((detailsByDocument) => Object.fromEntries(selectedDocuments.map((document) => [
      document,
      detailsByDocument[document] || { ...personalDetails },
    ])))
    setShowResidentInboxPage(false)
    setShowResidentCheck(true)
    setShowDocumentOptions(false)
    setShowRequestForm(true)
    setRequestDetailError('')
    setShowReview(false)
    setRequestSubmitted(false)
    setResidentStatus('registered')
    setReturnToResidentDashboardAfterRequest(true)
  }

  const updateRegistrationField = (field, value) => {
    setRegistrationData((currentData) => ({ ...currentData, [field]: value }))
  }

  const closeRegistrationWalkInGuide = () => {
    setRegistrationWalkInGuideOpen(false)
    window.requestAnimationFrame(() => registrationWalkInGuideTriggerRef.current?.focus())
  }

  const toggleRegistrationProofType = (proofType, checked) => {
    const currentTypes = Array.isArray(registrationData.proofOfResidence)
      ? registrationData.proofOfResidence
      : registrationData.proofOfResidence ? [registrationData.proofOfResidence] : []
    updateRegistrationField('proofOfResidence', checked
      ? [...currentTypes, proofType]
      : currentTypes.filter((type) => type !== proofType))
  }

  const loadLatestRegistrationRequests = async () => {
    if (!isDatabaseConnected) return registrationRequests
    const response = await fetchWithTimeout(API_URL, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Registration status refresh failed with status ${response.status}.`)
    const result = await response.json()
    if (!result.success || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
      throw new Error('The registration service returned invalid status data.')
    }
    const sharedRequests = result.data[registrationRequestsStorageKey] ?? []
    if (!Array.isArray(sharedRequests)) throw new Error('Saved registration requests must be a list.')
    const latestRequests = mergeRegistrationRequestLists(sharedRequests, registrationRequests)
    setRegistrationRequests(latestRequests)
    return latestRequests
  }

  const openMyRegistrationEditor = async (requestId) => {
    setRegistrationSubmitError('')
    setRegistrationStorageWarning('')
    let latestRequests
    try {
      latestRequests = await loadLatestRegistrationRequests()
    } catch (error) {
      console.error('Unable to verify registration status before editing.', error)
      setRegistrationSubmitError('The latest application status could not be checked. Please try again when the registration service is available.')
      return
    }

    const request = latestRequests.find((candidate) => candidate.id === requestId)
    if (!request) {
      setRegistrationSubmitError('This application could not be found. Check the reference number and try again.')
      return
    }
    if (request.status !== 'Pending') {
      setRegistrationSubmitError('This application can no longer be edited because it has been approved or declined.')
      return
    }

    setRegistrationData((currentData) => ({ ...currentData, ...(request.data || {}), ...registrationAddressDefaults }))
    setRegistrationFiles({ validId: null, proofOfResidence: null })
    setEditingRegistrationId(request.id)
    setSubmittedRegistrationId(request.id)
    setReturnToRegistrationCommunity(true)
    setResidentName({
      firstName: request.data?.firstName || '',
      middleName: request.data?.middleName || '',
      lastName: request.data?.lastName || '',
      suffix: request.data?.suffix || '',
      code: request.id,
    })
    setRegistrationSubmitted(false)
    setShowRegistrationForm(true)
    setShowResidentOptions(false)
    setShowResidentInboxPage(false)
    setShowResidentCheck(false)
    setInboxAccessMode(false)
  }

  const cancelRegistrationEdit = () => {
    const request = registrationRequests.find((candidate) => candidate.id === editingRegistrationId)
    if (request) setRegistrationData((currentData) => ({ ...currentData, ...(request.data || {}), ...registrationAddressDefaults }))
    setEditingRegistrationId('')
    setRegistrationFiles({ validId: null, proofOfResidence: null })
    setRegistrationSubmitError('')
    setRegistrationSubmitted(true)
    setRegistrationReferenceDialogOpen(false)
  }

  const returnToMyRegistrationSource = () => {
    const request = registrationRequests.find((candidate) => candidate.id === submittedRegistrationId)
    const notice = request?.status === 'Approved'
      ? {
        kind: 'approved',
        requestId: request.id,
        status: request.status,
        message: 'Your registration has been approved. Enter your application reference in Resident Login to view your assigned resident code.',
      }
      : request?.status === 'Declined'
        ? {
          kind: 'declined',
          requestId: request.id,
          status: request.status,
          message: request.rejectionReason || 'Sorry, your registration was not approved. Please contact the barangay office for more information.',
        }
        : request?.status === 'Pending'
          ? {
            kind: request.referenceAccessStatus === 'Paused' ? 'paused' : 'pending',
            requestId: request.id,
            status: request.status,
            message: request.referenceAccessStatus === 'Paused'
              ? request.referenceAccessNote || 'Your application is paused. Please follow the barangay office’s instructions.'
              : 'Your application is still under review. You can visit Community while you wait; other resident services will be available after approval.',
          }
          : null
    setRegistrationReferenceNotice(notice)
    setShowRegistrationForm(false)
    setShowResidentOptions(false)
    setShowResidentCheck(false)
    setShowResidentInboxPage(true)
    setInboxAccessMode(false)
    setRegistrationCommunityOnlyAccess(true)
    setResidentStatus('registered')
    setResidentLoginError('')
    setRegistrationSubmitError('')
    setReturnToRegistrationCommunity(false)
  }

  const submitRegistration = async (event) => {
    event.preventDefault()
    if (isSubmittingRegistration) return
    if (!isStorageLoaded) {
      setRegistrationSubmitError('Please wait for the registration service to finish loading, then submit again.')
      return
    }
    setIsSubmittingRegistration(true)
    setRegistrationSubmitError('')
    try {
      let requestsToUpdate = registrationRequests
      let existingRequest = null
      if (editingRegistrationId) {
        requestsToUpdate = await loadLatestRegistrationRequests()
        existingRequest = requestsToUpdate.find((request) => request.id === editingRegistrationId)
        if (!existingRequest || existingRequest.status !== 'Pending') {
          throw new Error('This application is no longer editable because it has been approved, declined, or removed.')
        }
      }

      const [validId, proofOfResidence] = await Promise.all([
        registrationFiles.validId
          ? createRegistrationEvidence(registrationFiles.validId)
          : Promise.resolve(existingRequest?.files?.validId),
        registrationFiles.proofOfResidence
          ? createRegistrationEvidence(registrationFiles.proofOfResidence)
          : Promise.resolve(existingRequest?.files?.proofOfResidence),
      ])
      if (!validId || !proofOfResidence) throw new Error('Upload both a valid ID and proof of residence.')
      const submittedAt = new Date()
      const referenceBytes = existingRequest ? null : window.crypto.getRandomValues(new Uint8Array(8))
      const referenceSuffix = referenceBytes
        ? Array.from(referenceBytes, (byte) => byte.toString(16).padStart(2, '0')).join('').toUpperCase()
        : ''
      const requestId = existingRequest?.id || `REG-${submittedAt.getFullYear()}-${referenceSuffix}`
      const submittedRegistrationData = { ...registrationData, ...registrationAddressDefaults }
      const address = [submittedRegistrationData.streetPurok, submittedRegistrationData.barangay, submittedRegistrationData.municipalityCity, submittedRegistrationData.province].filter(Boolean).join(', ')
      const fullRegisteredName = [registrationData.firstName, registrationData.middleName, registrationData.lastName, registrationData.suffix].filter(Boolean).join(' ')
      const request = {
        ...(existingRequest || {}),
        id: requestId,
        name: fullRegisteredName,
        address,
        ...(existingRequest ? {} : { submittedAt: submittedAt.toISOString() }),
        updatedAt: submittedAt.toISOString(),
        ...(existingRequest ? { residentUpdatedAt: submittedAt.toISOString() } : {}),
        status: 'Pending',
        ...(existingRequest ? { referenceAccessStatus: '', referenceAccessNote: '', reviewSteps: {} } : {}),
        data: submittedRegistrationData,
        files: { ...(existingRequest?.files || {}), validId, proofOfResidence },
        ...(!existingRequest ? { reviewSteps: {} } : {}),
      }
      const nextRequests = existingRequest
        ? requestsToUpdate.map((current) => current.id === requestId ? request : current)
        : [request, ...registrationRequests]
      let localStorageResult = null
      let localStorageError = null
      try {
        localStorageResult = await saveLocalRegistrationRequests(nextRequests)
      } catch (error) {
        localStorageError = error
        console.error('Unable to save registration requests in browser storage.', error)
      }
      let storageWarning = ''
      if (isDatabaseConnected) {
        try {
          await queueDatabaseRecords(databaseSaveQueueRef, { [registrationRequestsStorageKey]: nextRequests }, officialBackendToken)
        } catch (error) {
          if (localStorageError) {
            throw new Error(
              `The registration could not be saved to browser storage or the shared database. ${localStorageError.message} ${error.message}`,
              { cause: error },
            )
          }
          console.error('Registration saved in this browser but could not sync to the database.', error)
          storageWarning = existingRequest
            ? 'Your changes are saved in this browser, but could not sync to the shared database. The office may not see them until database access is restored.'
            : 'This application is saved in this browser, but could not sync to the shared database. The office may not see it until database access is restored.'
        }
      } else {
        if (localStorageError) {
          throw new Error(`The registration could not be saved because browser storage is full or unavailable. ${localStorageError.message}`)
        }
        storageWarning = existingRequest
          ? 'The database is not connected. Your changes are saved in this browser only and may not appear on the office computer.'
          : 'The database is not connected. This application is saved in this browser only and may not appear on the office computer.'
      }
      if (localStorageError && isDatabaseConnected) {
        storageWarning = existingRequest
          ? 'Your changes were sent to the shared database, but could not be cached in this browser. You can still use your application reference.'
          : 'The application was saved to the shared database, but could not be cached in this browser. You can still check its status with your application reference.'
      }
      if (localStorageResult && !localStorageResult.localStorageSaved) {
        storageWarning = `${storageWarning ? `${storageWarning} ` : ''}The browser cache is full, so the registration data was saved in local device storage instead.`
      }
      if (existingRequest && isDatabaseConnected && !storageWarning) {
        storageWarning = 'Your updated information was sent to the barangay office using the same application reference.'
      }
      setRegistrationRequests(nextRequests)
      setRegistrationStorageWarning(storageWarning)
      setSubmittedRegistrationId(requestId)
      if (returnToRegistrationCommunity && existingRequest) {
        setRegistrationReferenceNotice({
          kind: 'pending',
          requestId,
          status: 'Pending',
          message: 'Your updated application was sent to the barangay office and is waiting for review.',
        })
      }
      setResidentName({
        firstName: registrationData.firstName,
        middleName: registrationData.middleName,
        lastName: registrationData.lastName,
        suffix: registrationData.suffix,
        code: requestId,
      })
      setEditingRegistrationId('')
      setRegistrationSubmitted(true)
      setRegistrationReferenceDialogOpen(!existingRequest && !returnToRegistrationCommunity)
    } catch (error) {
      console.error('Unable to prepare the registration application.', error)
      setRegistrationSubmitError(error instanceof Error ? error.message : 'The registration application could not be saved.')
    } finally {
      setIsSubmittingRegistration(false)
    }
  }

  const checkRecoveryDetails = () => {
    setRecoveryFormError('')
    setRecoveryFormStatus('')
    setRecoveryLookupResult(null)
    const contactInfo = recoveryForm.contactInfo.trim()
    if (!recoveryForm.fullName.trim() || !recoveryForm.birthDate || !contactInfo) {
      setRecoveryFormError('Enter your registered full name, date of birth, and email address.')
      return
    }
    if (!isRecoveryEmail(contactInfo)) {
      setRecoveryFormError('Enter a valid email address.')
      return
    }

    const resident = adminResidents.find((record) => recoveryNamesMatch(recoveryForm.fullName, record.name))
    const registration = resident && registrationRequests.find((request) => (
      request.status === 'Approved'
      && request.assignedResidentCode?.toLowerCase() === resident.code?.toLowerCase()
    ))
    const savedBirthDate = resident?.dateOfBirth || resident?.birthDate || registration?.data?.birthDate || ''
    const savedEmail = resident?.emailAddress || registration?.data?.emailAddress || ''
    const birthDateMatches = Boolean(savedBirthDate && normalizeRecoveryDate(savedBirthDate) === recoveryForm.birthDate)
    const emailMatches = Boolean(savedEmail)
      && normalizeRecoveryEmail(savedEmail) === normalizeRecoveryEmail(contactInfo)

    if (resident && birthDateMatches && emailMatches) {
      setRecoveryFormStatus('Your name, birth date, and registered email match an existing resident record. Submit this request for staff review; your resident code will not be displayed online.')
    } else if (resident && !savedEmail) {
      setRecoveryFormStatus('No email address is saved on your resident record, so staff must verify your request manually. You can still submit it for review.')
    } else {
      setRecoveryFormStatus('We could not confirm all details automatically, including your registered email address. You may still submit this assistance request for staff review.')
    }
  }

  const submitRecoveryRequest = (event) => {
    event.preventDefault()
    const contactInfo = recoveryForm.contactInfo.trim()
    if (!isRecoveryEmail(contactInfo)) {
      setRecoveryFormError('Enter a valid email address.')
      return
    }
    const submittedAt = new Date()
    const requestDetails = {
      fullName: recoveryForm.fullName.trim(),
      birthDate: recoveryForm.birthDate,
      emailAddress: contactInfo,
      mobileNumber: '',
      address: recoveryForm.address.trim(),
      reason: recoveryForm.reason.trim(),
    }
    if (recoveryFormEditingRequestId) {
      const request = residentCodeRecoveryRequests.find((candidate) => candidate.id === recoveryFormEditingRequestId)
      if (!request || request.status !== 'Pending') {
        setRecoveryFormError('This request is already being reviewed and can no longer be edited.')
        return
      }
      const updatedRequest = { ...request, ...requestDetails, updatedAt: submittedAt.toISOString() }
      setResidentCodeRecoveryRequests((requests) => requests.map((candidate) => (
        candidate.id === request.id && candidate.status === 'Pending' ? updatedRequest : candidate
      )))
      setRecoverySubmittedId(request.id)
      setRecoveryFormEditingRequestId('')
      setRecoverySubmissionMessage('Your existing request was updated and remains pending for staff review.')
      setRecoveryLookup({ reference: request.id, fullName: updatedRequest.fullName })
      setRecoveryLookupResult({
        status: 'Pending',
        message: 'Your recovery request details have been updated and remain pending for staff review.',
        request: updatedRequest,
      })
      setRecoveryTrackingOpen(true)
      setRecoveryTrackingEditOpen(false)
      setRecoveryFormStatus('')
      setRecoveryFormError('')
      return
    }

    const requestId = `RC-${submittedAt.getFullYear()}-${Date.now().toString().slice(-6)}`
    const request = {
      id: requestId,
      ...requestDetails,
      status: 'Pending',
      submittedAt: submittedAt.toISOString(),
    }
    setResidentCodeRecoveryRequests((requests) => [request, ...requests])
    setRecoverySubmittedId(requestId)
    setRecoverySubmissionMessage('Request submitted for staff review.')
    setRecoveryLookup({ reference: requestId, fullName: request.fullName })
    setRecoveryLookupResult({ status: 'Pending', message: 'Your request was sent for staff review. Save the reference number and check back for recovery instructions.' })
    setRecoveryTrackingOpen(true)
    setRecoveryFormStatus('')
    setRecoveryFormError('')
  }

  const editSubmittedRecoveryRequest = () => {
    const request = residentCodeRecoveryRequests.find((candidate) => candidate.id === recoverySubmittedId)
    if (!request || request.status !== 'Pending') {
      setRecoverySubmissionMessage('This request is already being reviewed and can no longer be edited.')
      return
    }
    setRecoveryForm({
      fullName: request.fullName || '',
      birthDate: request.birthDate || '',
      contactInfo: request.emailAddress || '',
      address: request.address || '',
      reason: request.reason || '',
    })
    setRecoveryFormEditingRequestId(request.id)
    setRecoverySubmittedId('')
    setRecoverySubmissionMessage('')
    setRecoveryFormError('')
    setRecoveryFormStatus('')
    setRecoveryTrackingOpen(false)
    setRecoveryTrackingEditOpen(false)
  }

  const cancelRecoveryFormEdit = () => {
    const requestId = recoveryFormEditingRequestId
    const request = residentCodeRecoveryRequests.find((candidate) => candidate.id === requestId)
    setRecoveryFormEditingRequestId('')
    setRecoverySubmittedId(requestId)
    setRecoverySubmissionMessage(request?.status === 'Pending'
      ? 'No changes were saved.'
      : 'This request is already being reviewed and can no longer be edited.')
    setRecoveryFormError('')
    setRecoveryFormStatus('')
  }

  const checkRecoveryRequestStatus = (event) => {
    event.preventDefault()
    const request = residentCodeRecoveryRequests.find((candidate) => (
      candidate.id.toLowerCase() === recoveryLookup.reference.trim().toLowerCase()
      && recoveryNamesMatch(recoveryLookup.fullName, candidate.fullName)
    ))
    if (!request) {
      setRecoveryLookupResult({ status: 'not-found', message: 'No recovery request matches that reference and full name.' })
      setRecoveryTrackingEditOpen(false)
      return
    }
    const messages = {
      Pending: 'Your request is waiting for staff review.',
      Verified: request.codeSentAt
        ? 'Your identity was verified and a replacement resident code was emailed to the address on your resident record.'
        : 'Your identity was verified. The office is reviewing your recovery request.',
      Approved: request.codeSentAt
        ? 'Your request was approved and a replacement resident code was emailed to the address on your resident record.'
        : 'Your request was approved. A replacement resident code has not been emailed yet.',
      'Code issued': 'Your recovery request is complete.',
      Declined: request.declineNoticeSentAt
        ? 'Your request was declined and an email notice was sent.'
        : 'Your request was declined. No email notice was recorded.',
    }
    setRecoveryLookupResult({ status: request.status, message: messages[request.status] || 'Your request status is being reviewed.', request })
    setRecoveryTrackingEditOpen(false)
    setRecoveryTrackingEditError('')
  }

  const openRecoveryTrackingEdit = (request) => {
    setRecoveryTrackingEditForm({
      fullName: request.fullName || '',
      birthDate: request.birthDate || '',
      contactInfo: request.emailAddress || '',
      address: request.address || '',
      reason: request.reason || '',
    })
    setRecoveryTrackingEditError('')
    setRecoveryTrackingEditOpen(true)
  }

  const saveRecoveryTrackingEdit = (event) => {
    event.preventDefault()
    const request = residentCodeRecoveryRequests.find((candidate) => candidate.id === recoveryLookupResult?.request?.id)
    if (!request || request.status !== 'Pending') {
      if (request) {
        setRecoveryLookupResult({
          status: request.status,
          message: 'This request is already being reviewed and can no longer be edited.',
          request,
        })
      }
      setRecoveryTrackingEditOpen(false)
      return
    }
    const contactInfo = recoveryTrackingEditForm.contactInfo.trim()
    if (!recoveryTrackingEditForm.fullName.trim()
      || !recoveryTrackingEditForm.birthDate
      || !contactInfo
      || !recoveryTrackingEditForm.address.trim()
      || !recoveryTrackingEditForm.reason.trim()) {
      setRecoveryTrackingEditError('Complete all fields before saving your changes.')
      return
    }
    if (!isRecoveryEmail(contactInfo)) {
      setRecoveryTrackingEditError('Enter a valid email address.')
      return
    }
    const updatedRequest = {
      ...request,
      fullName: recoveryTrackingEditForm.fullName.trim(),
      birthDate: recoveryTrackingEditForm.birthDate,
      emailAddress: contactInfo,
      mobileNumber: '',
      address: recoveryTrackingEditForm.address.trim(),
      reason: recoveryTrackingEditForm.reason.trim(),
      updatedAt: new Date().toISOString(),
    }
    setResidentCodeRecoveryRequests((requests) => requests.map((candidate) => (
      candidate.id === request.id && candidate.status === 'Pending' ? updatedRequest : candidate
    )))
    setRecoveryLookup((lookup) => ({ ...lookup, fullName: updatedRequest.fullName }))
    setRecoveryLookupResult({
      status: updatedRequest.status,
      message: 'Your recovery request details have been updated and remain pending for staff review.',
      request: updatedRequest,
    })
    setRecoveryTrackingEditOpen(false)
    setRecoveryTrackingEditError('')
  }

  const replaceResidentCodeInRecords = (records, previousCode, newCode, fields) => records.map((record) => {
    if (!record || typeof record !== 'object') return record
    const updated = { ...record }
    fields.forEach((field) => {
      const currentCode = updated[field]
      if (typeof currentCode === 'string' && currentCode.trim().toUpperCase() === previousCode.toUpperCase()) {
        updated[field] = newCode
      }
    })
    return updated
  })

  const applyResidentCodeRotation = (previousCode, newCode, residentId) => {
    const updatedAt = new Date().toISOString()
    const residentIdentity = String(residentId || previousCode)
    const latestRecoveryLink = {
      matchedResidentId: residentIdentity,
      matchedResidentCode: newCode,
      verifiedAt: updatedAt,
    }
    const recordMatches = (record) => (
      String(record.id || '') === residentIdentity
      || String(record.code || '').trim().toUpperCase() === previousCode.toUpperCase()
    )
    setAdminResidents((records) => reconcileResidentCodeRotationRecords(records.map((record) => (
      recordMatches(record) ? {
        ...record,
        code: newCode,
        updatedAt,
      } : record
    )), [...residentCodeRecoveryRequests, latestRecoveryLink]))
    setResidentRequests((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setResidentPaymentDrafts((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setResidentDrafts((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setRegistrationRequests((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['assignedResidentCode', 'residentCode', 'resident_code']))
    setResidentProfileUpdateRequests((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setResidentHistory((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setArchivedResidents((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['code', 'residentCode', 'resident_code']))
    setIssuedDocuments((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['residentCode', 'resident_code']))
    setResidentCodeRecoveryRequests((records) => replaceResidentCodeInRecords(records, previousCode, newCode, ['matchedResidentCode', 'residentCode']))
  }

  const sendRecoveryCodeToSavedEmail = async (residentCode) => {
    const response = await fetch(`${BACKEND_API_URL}/resident-code-recovery.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${officialBackendToken}`,
      },
      body: JSON.stringify({ action: 'rotate_code', resident_code: residentCode, delivery_method: 'email' }),
    })
    const result = await response.json()
    const newResidentCode = result.data?.resident_code
    const residentId = result.data?.resident_id
    const validResidentId = result.data?.resident_source === 'shared'
      ? typeof residentId === 'string' && residentId.length > 0
      : Number.isInteger(Number(residentId)) && Number(residentId) > 0
    if (!response.ok || !result.success || !result.data?.delivery_method || result.data?.delivery_status !== 'Sent'
      || !validResidentId
      || typeof newResidentCode !== 'string' || !/^BB1-[A-Z0-9]{1,8}-\d{3}$/.test(newResidentCode)
      || newResidentCode.toUpperCase() === residentCode.trim().toUpperCase()) {
      throw new Error(result.message || 'The resident login code could not be sent.')
    }
    applyResidentCodeRotation(residentCode.trim().toUpperCase(), newResidentCode, residentId)
    return result.data
  }

  const sendRecoveryDeclinedNotice = async (request) => {
    const response = await fetch(`${BACKEND_API_URL}/resident-code-recovery.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${officialBackendToken}`,
      },
      body: JSON.stringify({
        action: 'decline_notice',
        request_id: request.id,
        recipient_email: request.emailAddress,
        resident_name: request.fullName,
      }),
    })
    const result = await response.json()
    if (!response.ok || !result.success || result.data?.delivery_status !== 'Sent') {
      throw new Error(result.message || 'The decline notice could not be sent.')
    }
    return result.data
  }

  const getRecoveryResidentDetails = (request) => {
    const resident = adminResidents.find((record) => record.id === request.matchedResidentId)
      || adminResidents.find((record) => recoveryNamesMatch(request.fullName, record.name))
      || getClosestResidentRecord(request.fullName, adminResidents)
    const registration = resident && registrationRequests.find((candidate) => (
      candidate.status === 'Approved'
      && candidate.assignedResidentCode?.toLowerCase() === resident.code?.toLowerCase()
    ))
    return {
      resident,
      savedBirthDate: resident?.dateOfBirth || resident?.birthDate || registration?.data?.birthDate || '',
      savedEmail: resident?.emailAddress || registration?.data?.emailAddress || '',
      savedAddress: resident?.address || registration?.address || '',
    }
  }

  const verifyRecoveryResident = (request) => {
    setAdminRecoveryMessage('')
    setRecoveryDeliveryMode('verify')
    setRecoveryDeliveryRequest(request)
  }

  const verifyRecoveryResidentWithEmail = async (request) => {
    if (isSendingRecoveryCode) return
    const { resident, savedEmail } = getRecoveryResidentDetails(request)
    if (!resident) {
      setAdminRecoveryMessage(`No existing resident record matches ${request.fullName}. Do not create a new account through recovery.`)
      return
    }
    if (!savedEmail) {
      setAdminRecoveryMessage(`No email address is saved for ${resident.name}. Update the resident record before sending the code by email.`)
      return
    }

    setIsSendingRecoveryCode(true)
    setAdminRecoveryMessage('')
    try {
      const delivery = await sendRecoveryCodeToSavedEmail(resident.code)
      const verifiedAt = new Date().toISOString()
      setResidentCodeRecoveryRequests((requests) => requests.map((candidate) => candidate.id === request.id
        ? {
          ...candidate,
          status: 'Verified',
          matchedResidentId: resident.id,
          matchedResidentCode: delivery.resident_code,
          deliveryMethod: 'email',
          deliveryDestination: delivery.destination || '',
          verifiedAt,
          codeSentAt: verifiedAt,
        }
        : candidate))
      setResidentHistory((history) => [{
        id: `resident-history-${Date.now()}`,
        resident: resident.name,
        action: `Resident login code replaced and emailed for recovery request ${request.id}`,
        date: verifiedAt,
      }, ...history])
      setRecoveryDeliveryRequest(null)
      setAdminRecoveryMessage(`A new resident login code was emailed to ${delivery.destination}. Resident Records and linked requests now use the new code.`)
    } catch (error) {
      console.error('Unable to verify the recovery request and send the resident code.', error)
      setAdminRecoveryMessage(error instanceof Error ? error.message : 'Unable to send the resident code. Check the backend configuration and try again.')
    } finally {
      setIsSendingRecoveryCode(false)
    }
  }

  const reviewRecoveryRequest = async (request, status) => {
    if (status === 'Approved' && request.status !== 'Verified') {
      setAdminRecoveryMessage('Verify the resident against an existing record before approving this request.')
      return
    }
    if (!['Approved', 'Declined'].includes(status)) return
    if (status === 'Declined' && !['Pending', 'Verified'].includes(request.status)) return
    let declineNotice = null
    if (status === 'Declined' && request.emailAddress) {
      if (!officialBackendToken) {
        setAdminRecoveryMessage('Sign in with an authorized backend admin account before emailing a decline notice.')
        return
      }
      setIsSendingRecoveryNotice(true)
      setAdminRecoveryMessage('Sending the decline notice to the submitted email address…')
      try {
        declineNotice = await sendRecoveryDeclinedNotice(request)
      } catch (error) {
        console.error('Unable to send the recovery decline notice.', error)
        setAdminRecoveryMessage(error instanceof Error ? error.message : 'The decline notice could not be sent. The request remains unchanged.')
        return
      } finally {
        setIsSendingRecoveryNotice(false)
      }
    }
    const reviewedAt = new Date().toISOString()
    setResidentCodeRecoveryRequests((requests) => requests.map((candidate) => candidate.id === request.id
      ? {
        ...candidate,
        status,
        reviewedAt,
        reviewNote: '',
        ...(declineNotice ? {
          declineNoticeSentAt: reviewedAt,
          declineNoticeDestination: declineNotice.destination || '',
        } : {}),
      }
      : candidate))
    setAdminRecoveryMessage(status === 'Declined'
      ? request.emailAddress
        ? 'The request was declined and an apology notice was emailed. No resident code was sent.'
        : 'The request was declined, but no email address was provided for a notice. No resident code was sent.'
      : `${request.fullName}'s recovery request was approved.`)
  }

  const sendApprovedRecoveryCode = (request) => {
    if (request.status !== 'Approved' || !request.matchedResidentCode) {
      setAdminRecoveryMessage('Approve a verified recovery request before sending its resident code.')
      return
    }
    if (!officialBackendToken) {
      setAdminRecoveryMessage('Sign in with an authorized backend admin account before sending a resident code.')
      return
    }
    setAdminRecoveryMessage('')
    setRecoveryDeliveryRequest(request)
    setRecoveryDeliveryMode('send')
  }

  const sendRecoveredResidentCode = async (request) => {
    if (!request || isSendingRecoveryCode) return
    setIsSendingRecoveryCode(true)
    setAdminRecoveryMessage('')
    try {
      const delivery = await sendRecoveryCodeToSavedEmail(request.matchedResidentCode)
      const codeSentAt = new Date().toISOString()
      setResidentCodeRecoveryRequests((requests) => requests.map((candidate) => candidate.id === request.id
        ? { ...candidate, matchedResidentCode: delivery.resident_code, deliveryMethod: 'email', deliveryDestination: delivery.destination || '', codeSentAt }
        : candidate))
      setResidentHistory((history) => [{
        id: `resident-history-${Date.now()}`,
        resident: request.fullName,
        action: `Resident login code replaced and emailed for recovery request ${request.id}`,
        date: codeSentAt,
      }, ...history])
      setRecoveryDeliveryRequest(null)
      setAdminRecoveryMessage(`A new resident login code was emailed to ${delivery.destination}. Resident Records and linked requests now use the new code.`)
    } catch (error) {
      console.error('Unable to send a recovered resident code.', error)
      setAdminRecoveryMessage(error instanceof Error ? error.message : 'Unable to send the resident code. Check the backend connection and try again.')
    } finally {
      setIsSendingRecoveryCode(false)
    }
  }

  const updateResidentAccountBackend = async (residentCode, action, attributes = {}) => {
    if (!officialBackendToken) return false
    const response = await fetch(`${BACKEND_API_URL}/resident-account-admin.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${officialBackendToken}`,
      },
      body: JSON.stringify({ resident_code: residentCode, action, ...attributes }),
    })
    const result = await response.json()
    if (!response.ok || !result.success) throw new Error(result.message || 'The resident account could not be updated.')
    return true
  }

  const saveResident = async (event) => {
    event.preventDefault()
    const existingResident = adminResidents.find((resident) => resident.id === editingResidentId)
    const cleanResident = {
      firstName: residentForm.firstName.trim(),
      middleName: residentForm.middleName.trim(),
      lastName: residentForm.lastName.trim(),
      suffix: residentForm.suffix.trim(),
      address: residentForm.address.trim(),
      birthDate: residentForm.birthDate,
      contactNumber: residentForm.contactNumber.trim(),
      emailAddress: residentForm.emailAddress.trim(),
      code: existingResident?.code || generateResidentCode(
        formatResidentName(residentForm),
        adminResidents,
      ),
    }
    cleanResident.name = formatResidentName(cleanResident)
    const duplicateResident = adminResidents.find((resident) => (
      resident.id !== editingResidentId
      && getResidentRecordNameKey(resident) === getResidentRecordNameKey(cleanResident)
    ))
    if (duplicateResident) {
      setResidentFormError(`A resident record with this name already exists (${duplicateResident.code}). Use that record instead.`)
      return
    }
    if (!cleanResident.emailAddress || !isRecoveryEmail(cleanResident.emailAddress)) {
      setResidentFormError('Enter a valid email address for this resident.')
      return
    }
    if (adminResidents.some((resident) => resident.code.toLowerCase() === cleanResident.code.toLowerCase() && resident.id !== editingResidentId)) {
      setResidentFormError('This resident code is already in use.')
      return
    }
    if (existingResident && officialBackendToken) {
      try {
        await updateResidentAccountBackend(existingResident.code, 'update_profile', {
          changes: {
            first_name: cleanResident.firstName,
            middle_name: cleanResident.middleName,
            last_name: cleanResident.lastName,
            suffix: cleanResident.suffix,
            address: cleanResident.address,
            date_of_birth: cleanResident.birthDate,
            contact_number: cleanResident.contactNumber,
            email: cleanResident.emailAddress,
          },
        })
      } catch (error) {
        console.error('Unable to update the resident account in the database.', error)
        setResidentFormError(error.message || 'Resident record changes were not saved to the database.')
        return
      }
    }
    const today = new Date().toISOString()
    const residentRecord = existingResident
      ? Object.fromEntries(Object.entries(existingResident).filter(([key]) => !['compliance', 'complianceSummary', 'complianceDate'].includes(key)))
      : {}
    const updatedResident = {
      ...residentRecord,
      ...cleanResident,
      id: existingResident?.id || cleanResident.code,
      ...(!existingResident ? { createdAt: today } : {}),
      updatedAt: today,
    }
    setAdminResidents((residents) => editingResidentId
      ? residents.map((resident) => resident.id === editingResidentId ? updatedResident : resident)
      : [...residents, updatedResident])
    if (existingResident) {
      const previousName = existingResident.name
      setResidentRequests((requests) => requests.map((request) => (
        request.residentCode?.toLowerCase() === existingResident.code.toLowerCase() || request.resident === previousName
          ? { ...request, resident: cleanResident.name }
          : request
      )))
    }
    setResidentHistory((history) => [{
      id: `resident-history-${Date.now()}`,
      resident: cleanResident.name,
      code: cleanResident.code,
      action: editingResidentId ? 'Updated resident record' : 'Added resident record',
      date: today,
    }, ...history])
    setResidentForm({ firstName: '', middleName: '', lastName: '', suffix: '', address: '', birthDate: '', contactNumber: '', emailAddress: '', code: '' })
    setEditingResidentId(null)
    setResidentFormOpen(false)
    setResidentFormError('')
    setResidentAccountMessage(officialBackendToken && existingResident
      ? 'Resident record changes were saved to the shared app and database.'
      : 'Resident record saved to shared app data. Database sign-in changes require an authorized backend admin session.')
  }

  const editResident = (resident) => {
    setResidentForm({
      ...getResidentNameParts(resident),
      address: resident.address || '',
      birthDate: resident.birthDate || resident.dateOfBirth || '',
      contactNumber: resident.contactNumber || resident.mobileNumber || '',
      emailAddress: resident.emailAddress || '',
      code: resident.code,
    })
    setEditingResidentId(resident.id)
    setResidentFormOpen(true)
    setResidentFormError('')
  }

  const toggleResidentRecordStatus = async (resident) => {
    const isActive = resident.recordStatus !== 'inactive'
    const recordStatus = isActive ? 'inactive' : 'active'
    if (officialBackendToken) {
      try {
        await updateResidentAccountBackend(resident.code, 'set_status', { status: recordStatus })
      } catch (error) {
        console.error('Unable to change resident account status in the database.', error)
        setResidentAccountMessage(error.message || 'Resident account status was not changed in the database.')
        return
      }
    }
    setAdminResidents((residents) => residents.map((currentResident) => currentResident.id === resident.id
      ? { ...currentResident, recordStatus, updatedAt: new Date().toISOString() }
      : currentResident))
    setResidentAccountMessage(officialBackendToken
      ? `Resident account marked ${recordStatus} in the app and database.`
      : `Resident record marked ${recordStatus} in shared app data. Database sign-in is unchanged until an authorized backend admin session is used.`)
  }

  const markRegistrationReviewStep = (request, stepKey) => {
    if (request.status !== 'Pending') return
    const nextStepKey = getRegistrationReviewSteps(request).find(({ key }) => !request.reviewSteps?.[key])?.key
    if (nextStepKey !== stepKey) return
    setRegistrationRequests((requests) => requests.map((current) => current.id === request.id
      ? { ...current, reviewSteps: { ...current.reviewSteps, [stepKey]: new Date().toISOString() } }
      : current))
  }

  const openRegistrationReview = (request, stepKey) => {
    if (!request || request.status !== 'Pending') return
    const steps = getRegistrationReviewSteps(request)
    const stepIndex = steps.findIndex((step) => step.key === stepKey)
    if (stepIndex < 0 || steps.slice(0, stepIndex).some((step) => !request.reviewSteps?.[step.key])) return
    setExpandedRegistrationId(request.id)
    setRegistrationReviewStage(stepKey)
    setRegistrationAdminNote(request.referenceAccessNote || '')
    setRegistrationActionError('')
    setRegistrationDecisionModalOpen(false)
  }

  const pauseRegistrationApplication = (request) => {
    if (request.status !== 'Pending') return
    const note = registrationAdminNote.trim()
    if (!note) {
      setRegistrationActionError('Enter a note for the applicant before pausing this application.')
      return
    }
    const updatedAt = new Date().toISOString()
    setRegistrationRequests((requests) => requests.map((current) => current.id === request.id
      ? {
        ...current,
        referenceAccessStatus: 'Paused',
        referenceAccessNote: note,
        referenceNoticeDismissedAt: '',
        updatedAt,
      }
      : current))
    setExpandedRegistrationId(null)
    setRegistrationReviewStage('')
    setRegistrationAdminNote('')
    setRegistrationActionError('')
    setRegistrationDecisionModalOpen(false)
  }

  const resumeRegistrationReview = (request) => {
    setRegistrationRequests((requests) => requests.map((current) => current.id === request.id
      ? { ...current, referenceAccessStatus: '', referenceAccessNote: '', updatedAt: new Date().toISOString() }
      : current))
    openRegistrationReview({ ...request, referenceAccessNote: '' }, getRegistrationReviewSteps()[0].key)
  }

  const reviewRegistration = async (request, status) => {
    if (request.status !== 'Pending') return
    if (getRegistrationReviewSteps(request).some(({ key }) => !request.reviewSteps?.[key])) return
    if (processingRegistrationId) return
    if (request.backendRegistrationId && !officialBackendToken) {
      setRegistrationActionError('Sign in with an authorized backend account to finish this registration review.')
      return
    }
    if (status === 'Declined' && !registrationAdminNote.trim()) {
      setRegistrationActionError('Enter a reason before declining this application.')
      return
    }

    let residentCode = ''
    setProcessingRegistrationId(request.id)
    setRegistrationActionError('')
    try {
      if (request.backendRegistrationId) {
        const endpoint = status === 'Approved' ? 'approve-registration.php' : 'reject-registration.php'
        const response = await fetch(`${BACKEND_API_URL}/${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${officialBackendToken}`,
          },
          body: JSON.stringify({
            registration_id: request.backendRegistrationId,
            ...(status === 'Declined' ? { rejection_reason: registrationAdminNote.trim() } : {}),
          }),
        })
        const result = await response.json()
        if (!response.ok || !result.success) {
          throw new Error(result.message || 'The registration decision could not be saved to the database.')
        }
        residentCode = result.data?.resident_code || ''
        if (status === 'Approved' && !residentCode) {
          throw new Error('The database approved the application without returning a resident code.')
        }
      } else if (status === 'Approved') {
        const normalizedName = normalizeResidentName(request.name)
        const requestNameWithoutSuffix = normalizeResidentName([
          request.data?.firstName,
          request.data?.middleName,
          request.data?.lastName,
        ].filter(Boolean).join(' '))
        const existingResident = adminResidents.find((resident) => {
          const existingName = normalizeResidentName(resident.name)
          return existingName === normalizedName || existingName === requestNameWithoutSuffix
        })
        residentCode = existingResident?.code || generateResidentCode(request.name, adminResidents)
      }

      if (status === 'Approved' && residentCode) {
        setAdminResidents((residents) => {
          const matchingResident = residents.find((resident) => resident.code?.toLowerCase() === residentCode.toLowerCase())
          if (matchingResident) {
            return matchingResident.recordStatus === 'inactive'
              ? residents.map((resident) => resident.id === matchingResident.id
                ? { ...resident, recordStatus: 'active', updatedAt: new Date().toISOString() }
                : resident)
              : residents
          }
          return [...residents, {
            id: residentCode,
            name: request.name,
            firstName: request.data?.firstName || '',
            middleName: request.data?.middleName || '',
            lastName: request.data?.lastName || '',
            suffix: request.data?.suffix || '',
            address: request.address,
            birthDate: request.data?.birthDate || '',
            contactNumber: request.data?.mobileNumber || '',
            emailAddress: request.data?.emailAddress || '',
            code: residentCode,
            recordStatus: 'active',
            createdAt: new Date().toISOString(),
          }]
        })
      }

      const reviewedAt = new Date().toISOString()
      const nextRequests = registrationRequests.map((current) => current.id === request.id
        ? {
          ...current,
          status,
          reviewedAt,
          referenceAccessStatus: '',
          referenceAccessNote: '',
          referenceNoticeDismissedAt: '',
          ...(residentCode ? { assignedResidentCode: residentCode } : {}),
          ...(status === 'Declined' ? { rejectionReason: registrationAdminNote.trim() } : {}),
        }
        : current)
      if (status === 'Declined') {
        const syncErrors = []
        try {
          await saveLocalRegistrationRequests(nextRequests)
        } catch (error) {
          console.error('Unable to save the rejected registration notice in local browser storage.', error)
          syncErrors.push('the note could not be saved in this browser')
        }
        if (isDatabaseConnected) {
          try {
            await saveDatabaseRecords({ [registrationRequestsStorageKey]: nextRequests }, officialBackendToken)
          } catch (error) {
            console.error('Unable to sync the rejected registration notice to the shared database.', error)
            syncErrors.push('the note could not be synced to the shared database')
          }
        } else {
          syncErrors.push('the shared database is unavailable, so the resident may not see the note on another device')
        }
        setRegistrationSyncError(syncErrors.length
          ? `The rejection was recorded, but ${syncErrors.join(' and ')}. Restore database access so the resident can receive it.`
          : '')
      }
      setRegistrationRequests(nextRequests)
      setExpandedRegistrationId(null)
      setRegistrationReviewStage('details')
      setRegistrationAdminNote('')
      setRegistrationDecisionModalOpen(false)
    } catch (error) {
      console.error(`Unable to ${status.toLowerCase()} registration ${request.id}.`, error)
      setRegistrationActionError(error.message || 'The registration decision could not be saved.')
    } finally {
      setProcessingRegistrationId('')
    }
  }

  const submitPasswordChange = (event) => {
    event.preventDefault()
    if (passwordFields.current !== adminPassword) {
      setPasswordMessage('Current password does not match.')
      return
    }
    if (passwordFields.next.length < 8) {
      setPasswordMessage('New password must be at least 8 characters.')
      return
    }
    if (passwordFields.next !== passwordFields.confirm) {
      setPasswordMessage('New passwords do not match.')
      return
    }
    setAdminPassword(passwordFields.next)
    setPasswordFields({ current: '', next: '', confirm: '' })
    setPasswordMessage('Password changed for this session only. It is not stored in the browser or account database.')
  }

  const addAdminEmail = async (event) => {
    event.preventDefault()
    const email = newAdminEmail.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setAdminInvitationError('Enter a valid email address.')
      return
    }
    if (!officialBackendToken) {
      setAdminInvitationError('Sign in with an active backend administrator account before inviting another admin.')
      return
    }
    setAdminInvitationError('')
    setAdminInvitationMessage('')
    setIsSendingAdminInvitation(true)
    try {
      const response = await fetch(`${BACKEND_API_URL}/admin-invitations.php`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${officialBackendToken}`,
        },
        body: JSON.stringify({ action: 'invite', email }),
      })
      const result = await response.json()
      if (!response.ok || !result.success || !result.invitation) {
        throw new Error(result.message || 'The admin invitation could not be sent.')
      }
      setAdminInvitations((invitations) => [
        result.invitation,
        ...invitations.filter((invitation) => invitation.id !== result.invitation.id),
      ])
      setNewAdminEmail('')
      const linkNotice = result.invitationUrlConfigured
        ? ' They can accept using the link in the email.'
        : ' The link uses this backend address; the recipient can accept only if their device can reach it. Set BRGY_ADMIN_INVITATION_URL for remote access.'
      setAdminInvitationMessage(`Gmail accepted the invitation for delivery to ${email}. If it is not in the inbox, check Spam.${linkNotice} Admin access is granted only after they accept.`)
    } catch (error) {
      console.error(`Unable to send an admin invitation to ${email}.`, error)
      setAdminInvitationError(error.message || 'The admin invitation could not be sent.')
    } finally {
      setIsSendingAdminInvitation(false)
    }
  }

  const updateOfficialPhoto = async (event, index) => {
    const file = event.target.files?.[0]
    if (!file) return
    setOfficialPhotoError('')
    try {
      const dataUrl = await createOfficialPortrait(file)
      const updatedPhotos = { ...officialPhotos, [index]: dataUrl }
      await saveLocalOfficialPhotos(updatedPhotos)
      setOfficialPhotos(updatedPhotos)
      if (isDatabaseConnected) {
        try {
          await saveDatabaseRecords({ [officialPhotosStorageKey]: updatedPhotos }, officialBackendToken)
        } catch (error) {
          console.error('Unable to sync official photos to the shared database.', error)
          setOfficialPhotoError('Photo saved on this device, but could not sync to the shared system. Check the database connection.')
        }
      } else {
        setOfficialPhotoError('Photo saved on this device. The shared database is unavailable, so other devices will not see it yet.')
      }
    } catch (error) {
      console.error(`Unable to prepare the portrait for official ${index + 1}.`, error)
      setOfficialPhotoError(error.message || 'The official photo could not be saved.')
    } finally {
      event.target.value = ''
    }
  }

  const updateOfficialProfile = (index, field, value) => {
    setOfficialProfiles((profiles) => profiles.map((profile, profileIndex) => (
      profileIndex === index ? { ...profile, [field]: value } : profile
    )))
  }

  const addOfficialProfile = () => {
    const newOfficialIndex = officialProfiles.length
    setOfficialProfiles([...officialProfiles, { name: '', role: 'Barangay Official', description: '' }])
    setExpandedOfficialIndex(newOfficialIndex)
  }

  const toggleDocument = (document) => {
    if (!enabledCertificateTypes.includes(document)) return
    const updatedDocuments = selectedDocuments.includes(document)
      ? selectedDocuments.filter((currentDocument) => currentDocument !== document)
      : [...selectedDocuments, document]
    const updatedDetailsByDocument = {
      ...personalDetailsByDocument,
      ...(updatedDocuments.includes(document) && !personalDetailsByDocument[document] ? { [document]: { ...personalDetails } } : {}),
    }
    const updatedCopyCounts = {
      ...documentCopyCounts,
      ...(updatedDocuments.includes(document) && documentCopyCounts[document] === undefined ? { [document]: 1 } : {}),
    }
    const updatedPhotos = mergeSharedRequirementPhotos(requirementPhotos, updatedDocuments, customCertificateTemplates)
    setSelectedDocuments(updatedDocuments)
    if (!updatedDocuments.includes(activeRequestDocument)) setActiveRequestDocument(updatedDocuments[0] || '')
    setPersonalDetailsByDocument(updatedDetailsByDocument)
    setDocumentCopyCounts(updatedCopyCounts)
    replaceRequirementPhotos(updatedPhotos)
    setResidentDocumentGuideReviewed(false)
    saveResidentDraft({
      selectedDocuments: updatedDocuments,
      detailsByDocument: updatedDetailsByDocument,
      documentCopyCounts: updatedCopyCounts,
      requirementPhotos: updatedPhotos,
    })
  }

  const persistResidentDraftList = (drafts) => {
    saveResidentLocalRecord(residentDraftsStorageKey, drafts)
      .then(() => setResidentDraftError(''))
      .catch((error) => {
        console.error('Unable to save resident request drafts in browser storage.', error)
        setResidentDraftError('Your draft could not be saved to this browser. Check available storage space and try again.')
      })
  }

  const saveResidentDraft = (overrides = {}) => {
    const draftDocuments = overrides.selectedDocuments || selectedDocuments
    const draftDetails = overrides.details || personalDetails
    const draftDetailsByDocument = overrides.detailsByDocument || personalDetailsByDocument
    const draftCopyCounts = overrides.documentCopyCounts || documentCopyCounts
    const draftPhotos = overrides.requirementPhotos || requirementPhotos
    const hasDraftValue = (value) => {
      if (Array.isArray(value)) return value.some(hasDraftValue)
      if (value && typeof value === 'object') return Object.values(value).some(hasDraftValue)
      if (typeof value === 'string') return Boolean(value.trim())
      return value !== undefined && value !== null && value !== false
    }
    const hasDraftContent = draftDocuments.length > 0
      || Object.values(draftDetails).some(hasDraftValue)
      || Object.values(draftDetailsByDocument).some((details) => Object.values(details || {}).some(hasDraftValue))
      || draftDocuments.some((document) => Number(draftCopyCounts[document]) > 1)
      || Object.keys(draftPhotos).length > 0
    if (!hasDraftContent) return null

    const draftId = activeResidentDraftIdRef.current || createResidentDraftId()
    const updatedDraft = {
      id: draftId,
      resident: fullName,
      residentCode: residentName.code.trim().toUpperCase(),
      documents: draftDocuments,
      details: draftDetails,
      detailsByDocument: draftDetailsByDocument,
      documentCopyCounts: draftCopyCounts,
      requirementPhotos: draftPhotos,
      status: 'in-progress',
      updatedAt: new Date().toISOString(),
    }
    activeResidentDraftIdRef.current = draftId
    const updatedDrafts = [updatedDraft, ...residentDrafts.filter((draft) => draft.id !== draftId)]
    setResidentDrafts(updatedDrafts)
    persistResidentDraftList(updatedDrafts)
    return draftId
  }

  const preserveActiveResidentDraft = () => {
    const draftId = activeResidentDraftIdRef.current
    if (!draftId) return
    const updatedDrafts = residentDraftsRef.current.map((draft) => draft.id === draftId
      ? { ...draft, status: 'saved', updatedAt: new Date().toISOString() }
      : draft)
    if (updatedDrafts.some((draft) => draft.id === draftId)) {
      setResidentDrafts(updatedDrafts)
      persistResidentDraftList(updatedDrafts)
    }
  }

  const leaveRequestAsDraft = () => {
    const draftId = saveResidentDraft()
    if (!draftId) {
      setShowResidentCheck(false)
      setShowDocumentOptions(false)
      setShowRequestForm(false)
      setShowReview(false)
      setRequestSubmitted(false)
      setShowResidentInboxPage(true)
      setSelectedInboxRequestId(null)
      setResidentDashboardSection('request-documents')
      setReturnToResidentDashboardAfterRequest(false)
      return
    }
    preserveActiveResidentDraft()
    setShowResidentCheck(false)
    setShowDocumentOptions(false)
    setShowRequestForm(false)
    setShowReview(false)
    setRequestSubmitted(false)
    setShowResidentInboxPage(true)
    setSelectedInboxRequestId(null)
    setResidentDashboardSection('request-documents')
    setReturnToResidentDashboardAfterRequest(false)
  }

  const resumeResidentDraft = (draft) => {
    activeResidentDraftIdRef.current = draft.id
    const updatedDrafts = residentDrafts.map((currentDraft) => currentDraft.id === draft.id
      ? { ...currentDraft, status: 'in-progress' }
      : currentDraft)
    setResidentDrafts(updatedDrafts)
    persistResidentDraftList(updatedDrafts)
    const draftDocuments = draft.documents || []
    setSelectedDocuments(draftDocuments)
    setDocumentCopyCounts(draft.documentCopyCounts || Object.fromEntries(draftDocuments.map((document) => [document, 1])))
    setPersonalDetails({ address: '', contactNumber: '', birthDate: '', purpose: '', ...(draft.details || {}) })
    setPersonalDetailsByDocument(draft.detailsByDocument || Object.fromEntries(draftDocuments.map((document) => [document, { address: '', contactNumber: '', birthDate: '', purpose: '', ...(draft.details || {}) }])))
    setActiveRequestDocument(draftDocuments[0] || '')
    replaceRequirementPhotos(mergeSharedRequirementPhotos(draft.requirementPhotos, draftDocuments, customCertificateTemplates))
    setRequirementPhotoLoading({})
    setRequirementPhotoError('')
    setShowResidentCheck(true)
    setShowDocumentOptions(false)
    setShowRequestForm(true)
    setRequestDetailError('')
    setShowReview(false)
    setRequestSubmitted(false)
    setShowResidentInboxPage(false)
    setReturnToResidentDashboardAfterRequest(true)
  }

  const deleteResidentDraft = (draftId) => {
    const updatedDrafts = residentDrafts.filter((draft) => draft.id !== draftId)
    setResidentDrafts(updatedDrafts)
    persistResidentDraftList(updatedDrafts)
    if (activeResidentDraftIdRef.current === draftId) {
      activeResidentDraftIdRef.current = null
    }
  }

  const movePaymentRequestToDraft = (request) => {
    const documents = request.documents || []
    const detailsByDocument = request.detailsByDocument || request.certificateData || {}
    const draft = {
      id: createResidentDraftId(),
      resident: request.resident,
      residentCode: request.residentCode,
      documents,
      details: request.details || {},
      detailsByDocument,
      documentCopyCounts: request.documentCopyCounts || Object.fromEntries(documents.map((document) => [
        document,
        Number(request.copyCount) || 1,
      ])),
      requirementPhotos: request.requirementPhotos || {},
      status: 'saved',
      updatedAt: new Date().toISOString(),
    }
    const updatedDrafts = [draft, ...residentDrafts]
    setResidentDrafts(updatedDrafts)
    persistResidentDraftList(updatedDrafts)
    setResidentPaymentDrafts((drafts) => drafts.filter((paymentDraft) => paymentDraft.id !== request.id))
    setSelectedPaymentRequestIds((requestIds) => requestIds.filter((requestId) => requestId !== request.id))
    setPaymentBatchOpen(false)
    setWalkInPaymentNoticeOpen(false)
    setPaymentMethod('')
    setPaymentProof(null)
    setPaymentProofOrNumber('')
    setPaymentProofError('')
  }

  const deleteSelectedUnsubmittedPaymentRequests = () => {
    const deletableRequestIds = new Set(
      selectedResidentPaymentRequests
        .filter((request) => request.awaitingPaymentSubmission)
        .map((request) => request.id),
    )
    if (!deletableRequestIds.size) return

    const deletableRequests = selectedResidentPaymentRequests.filter((request) => (
      deletableRequestIds.has(request.id)
    ))
    const requestNames = deletableRequests
      .map((request) => request.documents?.join(' · ') || 'Document request')
      .join('\n')
    if (!window.confirm(
      `Delete ${deletableRequests.length} unsubmitted payment request${deletableRequests.length === 1 ? '' : 's'}?\n\n${requestNames}\n\nSubmitted requests and payment proofs will not be deleted.`,
    )) return

    setResidentPaymentDrafts((drafts) => drafts.filter((draft) => !deletableRequestIds.has(draft.id)))
    setSelectedPaymentRequestIds((requestIds) => requestIds.filter((requestId) => (
      !deletableRequestIds.has(requestId)
    )))
    setPaymentBatchOpen(false)
    setPaymentMethod('')
    setPaymentProof(null)
    setPaymentProofOrNumber('')
    setPaymentProofError('')
  }

  const updatePaymentSelection = (requestIds) => {
    setSelectedPaymentRequestIds(requestIds)
    setPaymentBatchOpen(false)
    setPaymentProof(null)
    setPaymentProofOrNumber('')
    setPaymentProofError('')
  }

  const togglePaymentRequestSelection = (requestId) => {
    updatePaymentSelection(selectedPaymentRequestIds.includes(requestId)
      ? selectedPaymentRequestIds.filter((selectedId) => selectedId !== requestId)
      : [...selectedPaymentRequestIds, requestId])
  }

  const cancelResidentRequest = (request) => {
    if (request.status !== 'New') return
    const hasSubmittedPayment = Number(request.feeAmount || 0) > 0
      && ['Paid', 'Pending verification'].includes(request.paymentStatus)
    const documentLabel = request.documents?.join(' · ') || 'this request'
    if (hasSubmittedPayment) {
      setCancellationGcashNumber(request.refundDestinationNumber || '')
      setCancellationGcashError('')
      setResidentCancellationRequestId(request.id)
      return
    }
    if (!window.confirm(`Cancel ${documentLabel}? It will no longer be processed.`)) return
    finishResidentRequestCancellation(request)
  }

  const finishResidentRequestCancellation = (request, gcashNumber = '') => {
    const cancelledAt = new Date()
    const activityTime = cancelledAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
    setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id
      ? {
        ...currentRequest,
        status: 'Cancelled',
        cancelledAt: cancelledAt.toISOString(),
        ...(gcashNumber ? { refundDestinationNumber: gcashNumber } : {}),
        statusHistory: [...(currentRequest.statusHistory || []), { status: 'Cancelled', changedAt: cancelledAt.toISOString() }],
        activity: [...(currentRequest.activity || []), {
          action: 'Request cancelled by resident before review',
          by: 'Resident',
          time: activityTime,
        }],
      }
      : currentRequest))
    setResidentCancellationRequestId('')
    setCancellationGcashNumber('')
    setCancellationGcashError('')
    setSelectedInboxRequestId(null)
    setResidentDraftsCorrectionsTab('cancelled')
    setResidentDashboardSection('drafts-corrections')
  }

  const submitResidentRequestCancellation = (event) => {
    event.preventDefault()
    if (!residentCancellationRequest || residentCancellationRequest.status !== 'New') return
    const number = cancellationGcashNumber.trim()
    const normalizedNumber = number.replace(/[\s()-]/g, '')
    if (!/^(?:09\d{9}|\+639\d{9}|639\d{9})$/.test(normalizedNumber)) {
      setCancellationGcashError('Enter a valid GCash mobile number, such as 09XX XXX XXXX.')
      return
    }
    finishResidentRequestCancellation(residentCancellationRequest, number)
  }

  const updatePersonalDetail = (field, value) => {
    const updatedDetails = { ...(personalDetailsByDocument[currentRequestDocument] || personalDetails), [field]: value }
    const updatedDetailsByDocument = { ...personalDetailsByDocument, [currentRequestDocument]: updatedDetails }
    setPersonalDetailsByDocument(updatedDetailsByDocument)
    setRequestDetailError('')
    saveResidentDraft({ detailsByDocument: updatedDetailsByDocument })
  }

  const updateDocumentCopyCount = (document, value) => {
    const updatedCopyCounts = { ...documentCopyCounts, [document]: value }
    setDocumentCopyCounts(updatedCopyCounts)
    setRequestDetailError('')
    saveResidentDraft({ documentCopyCounts: updatedCopyCounts })
  }

  const updateRequirementPhoto = async (photoKey, file) => {
    setRequirementPhotoError('')
    if (!file) return
    const storedPhotoKey = getRequirementPhotoStorageKey(currentRequestDocument, photoKey, selectedDocuments)
    setRequirementPhotoLoading((loading) => ({ ...loading, [storedPhotoKey]: true }))
    try {
      const photo = await createRequirementPhoto(file)
      const currentPhotos = requirementPhotosRef.current
      const updatedPhotos = {
        ...currentPhotos,
        [storedPhotoKey]: photo,
        ...(selectedDocuments.length === 1 && currentPhotos[photoKey] ? { [photoKey]: photo } : {}),
      }
      replaceRequirementPhotos(updatedPhotos)
      saveResidentDraft({ requirementPhotos: updatedPhotos })
    } catch (error) {
      console.error('Unable to prepare a resident requirement photo.', error)
      setRequirementPhotoError(`${file.name}: ${error.message}`)
    } finally {
      setRequirementPhotoLoading((loading) => ({ ...loading, [storedPhotoKey]: false }))
    }
  }

  const updatePhilSysVerificationEvidence = async (file) => {
    setRequirementPhotoError('')
    if (!file) return
    setRequirementPhotoLoading((loading) => ({ ...loading, [philsysEvidencePhotoKey]: true }))
    try {
      const photo = await createRequirementPhoto(file)
      const updatedPhotos = { ...requirementPhotosRef.current, [philsysEvidencePhotoKey]: photo }
      replaceRequirementPhotos(updatedPhotos)
      saveResidentDraft({ requirementPhotos: updatedPhotos })
    } catch (error) {
      console.error('Unable to prepare PhilSys verification evidence.', error)
      setRequirementPhotoError(`${file.name}: ${error.message}`)
    } finally {
      setRequirementPhotoLoading((loading) => ({ ...loading, [philsysEvidencePhotoKey]: false }))
    }
  }

  const submitRequest = (event) => {
    event.preventDefault()
    if (requirementPhotoError || Object.values(requirementPhotoLoading).some(Boolean)) return
    const invalidCopyDocument = selectedDocuments.find((document) => (
      getDocumentCopyCount(document) === null || getDocumentFeeSubtotal(document) === null
    ))
    if (invalidCopyDocument || getSelectedRequestFeeTotal() === null) {
      const document = invalidCopyDocument || selectedDocuments[0]
      setActiveRequestDocument(document)
      setRequestDetailError(`${document}: enter a whole number of copies (at least 1) and keep the total fee within the supported range.`)
      return
    }
    const submittedRequirementPhotos = requirementPhotosRef.current
    if (!submittedRequirementPhotos[philsysEvidencePhotoKey]) {
      setRequirementPhotoError('Upload a screenshot or photo of the successful PhilSys Check result.')
      return
    }
    for (const document of selectedDocuments) {
      const documentFields = getCertificateTemplateFields(document, customCertificateTemplates)
      const documentDetails = getRequestCertificateValuesForDocument(document)
      const missingChoice = documentFields.find((field) => (
        field.isCheckbox && (
          field.multiple
            ? !Array.isArray(documentDetails[field.key]) || !documentDetails[field.key].length
            : !documentDetails[field.key]
        )
      ))
      if (missingChoice) {
        setActiveRequestDocument(document)
        setRequestDetailError(`${document}: choose an option for ${missingChoice.label}.`)
        return
      }
      const missingField = documentFields.find((field) => !hasCertificateFieldValue(documentDetails, field))
      if (missingField) {
        setActiveRequestDocument(document)
        setRequestDetailError(`${document}: enter ${missingField.label}.`)
        return
      }
      const hasPurposeField = hasPurposeCertificateField(documentFields)
      if (!hasPurposeField && !String(documentDetails.purpose || '').trim()) {
        setActiveRequestDocument(document)
        setRequestDetailError(`${document}: enter the purpose of the request.`)
        return
      }
      const missingRequirement = getDocumentRequirements(document, customCertificateTemplates).find((requirement) => {
        return getRequirementPhotoKeys(requirement).some((photoKey) => (
          !getAvailableRequirementPhoto(submittedRequirementPhotos, document, photoKey, selectedDocuments)
        ))
      })
      if (missingRequirement) {
        setActiveRequestDocument(document)
        setRequestDetailError(`${document}: upload a photo of ${missingRequirement}.`)
        return
      }
    }
    setRequestDetailError('')
    setShowRequestForm(false)
    setShowReview(true)
  }

  const confirmRequest = () => {
    const submittedRequirementPhotos = requirementPhotosRef.current
    const availableDocuments = [...new Set(
      selectedDocuments.filter((document) => enabledCertificateTypes.includes(document))
    )]
    if (!availableDocuments.length) return
    const invalidCopyDocument = availableDocuments.find((document) => (
      getDocumentCopyCount(document) === null || getDocumentFeeSubtotal(document) === null
    ))
    if (invalidCopyDocument || getSelectedRequestFeeTotal(availableDocuments) === null) {
      const document = invalidCopyDocument || availableDocuments[0]
      setActiveRequestDocument(document)
      setRequestDetailError(`${document}: enter a whole number of copies (at least 1) and keep the total fee within the supported range.`)
      setShowReview(false)
      setShowRequestForm(true)
      return
    }
    const hasPaidDocuments = availableDocuments.some((document) => (getDocumentFeeSubtotal(document) || 0) > 0)
    const requestedAt = new Date()
    const submittedDraftId = activeResidentDraftIdRef.current
    const detailsByDocument = Object.fromEntries(availableDocuments.map((document) => {
      const documentValues = getRequestCertificateValuesForDocument(document)
      const certificateFields = getCertificateTemplateFields(document, customCertificateTemplates)
      const documentDetails = Object.fromEntries(certificateFields.map((field) => [
        field.key,
        documentValues[field.key] || '',
      ]))
      return [document, {
        ...documentValues,
        ...documentDetails,
        address: documentValues.address || documentValues.businessAddress || documentValues.appearanceAddress || '',
        purpose: getNormalizedRequestPurpose({ ...documentValues, ...documentDetails }, certificateFields),
      }]
    }))
    const randomSuffix = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : Array.from(globalThis.crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join('')
    const submissionId = `BR-${requestedAt.getFullYear()}-${requestedAt.getTime()}-${randomSuffix}`
    const requestsByDocument = availableDocuments.map((document, index) => {
      const documentPhotos = Object.fromEntries(getDocumentRequirements(document, customCertificateTemplates).flatMap((requirement) => (
        getRequirementPhotoKeys(requirement).flatMap((photoKey) => {
          const photo = getAvailableRequirementPhoto(submittedRequirementPhotos, document, photoKey, availableDocuments)
          return photo ? [[getDocumentPhotoKey(document, photoKey), photo]] : []
        })
      )))
      const documentRequirementFiles = Object.entries(documentPhotos).map(([key, photo]) => (
        `${document} · ${key.slice(key.indexOf('__') + 2).replace(/-/g, ' ')}: ${photo.fileName}`
      ))
      const documentDetails = detailsByDocument[document]
      const copyCount = getDocumentCopyCount(document)
      const unitFeeAmount = Number(documentFees[document] || 0)
      const feeAmount = getDocumentFeeSubtotal(document)
      const requestTime = requestedAt.toISOString()
      return {
        id: availableDocuments.length === 1 ? submissionId : `${submissionId}-${String(index + 1).padStart(2, '0')}`,
        submissionId,
        resident: fullName,
        residentCode: residentName.code.trim().toUpperCase(),
        documents: [document],
        copyCount,
        unitFeeAmount,
        feeAmount,
        ...(feeAmount > 0 ? {
          paymentDraftedAt: requestTime,
          awaitingPaymentSubmission: true,
          paymentStatus: 'Unpaid',
        } : {
          requestedAt: requestTime,
          status: 'New',
          paymentStatus: 'Not required',
          statusHistory: [{ status: 'New', changedAt: requestTime }],
          activity: [{
            action: 'Request submitted',
            by: 'Resident',
            time: requestedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
          }],
        }),
        certificateData: { [document]: documentDetails },
        detailsByDocument: { [document]: documentDetails },
        details: { ...personalDetails, ...documentDetails, purpose: documentDetails.purpose || '' },
        requirements: documentRequirementFiles,
        requirementPhotos: documentPhotos,
      }
    })
    const philsysVerificationEvidence = submittedRequirementPhotos[philsysEvidencePhotoKey]
    const evidenceRequestIndex = Math.max(0, requestsByDocument.findIndex((request) => !request.awaitingPaymentSubmission))
    const requestsWithEvidence = requestsByDocument.map((request, index) => (
      index === evidenceRequestIndex && philsysVerificationEvidence
        ? {
          ...request,
          philsysVerificationEvidence: {
            ...philsysVerificationEvidence,
            provider: 'PhilSys Check',
            reviewStatus: 'Evidence submitted for staff review',
            submittedAt: requestedAt.toISOString(),
          },
        }
        : request
    ))
    const requestsToSubmit = requestsWithEvidence.filter((request) => !request.awaitingPaymentSubmission)
    const requestsAwaitingPayment = requestsWithEvidence.filter((request) => request.awaitingPaymentSubmission)
    if (requestsToSubmit.length) setResidentRequests((requests) => [...requestsToSubmit, ...requests])
    if (requestsAwaitingPayment.length) setResidentPaymentDrafts((drafts) => [...requestsAwaitingPayment, ...drafts])
    setShowReview(false)
    setShowRequestForm(false)
    setRequestSubmitted(requestsToSubmit.length > 0 || requestsAwaitingPayment.length > 0)
    setRequestSubmittedHasPayment(hasPaidDocuments)
    if (submittedDraftId) {
      const updatedDrafts = residentDrafts.filter((draft) => draft.id !== submittedDraftId)
      setResidentDrafts(updatedDrafts)
      persistResidentDraftList(updatedDrafts)
    }

    activeResidentDraftIdRef.current = null
    setPersonalDetailsByDocument({})
    setActiveRequestDocument('')
    setDocumentCopyCounts({})
    replaceRequirementPhotos({})
    setRequirementPhotoLoading({})
    setRequirementPhotoError('')
    if (hasPaidDocuments) {
      setShowResidentCheck(false)
      setShowResidentInboxPage(true)
      markResidentDashboardSectionRead('payments')
      setResidentDashboardSection('payments')
      setReturnToResidentDashboardAfterRequest(true)
    } else if (returnToResidentDashboardAfterRequest) {
      setShowResidentCheck(false)
      setShowResidentInboxPage(true)
      setResidentDashboardSection('requests')
    }
  }

  const resubmitCorrectedRequest = (request, corrections) => {
    const requestToCorrect = residentRequests.find((currentRequest) => (
      currentRequest.id === request.id && currentRequest.status === 'Returned for edits'
    ))
    const invalidKeys = requestToCorrect?.invalidRequirements || []
    const correctionPhotos = corrections?.photos || {}
    const certificateFields = getCertificateCorrectionFields(requestToCorrect || request, customCertificateTemplates)
    const certificateFieldByKey = new Map(certificateFields.map((item) => [item.correctionKey, item]))
    const correctedFieldValues = corrections?.certificateFields || {}
    const hasCorrectionValue = (value) => Array.isArray(value)
      ? value.some((item) => String(item || '').trim())
      : Boolean(String(value || '').trim())
    if (!requestToCorrect || !invalidKeys.length || invalidKeys.some((key) => (
      !correctionPhotos[key] && !(certificateFieldByKey.has(key) && hasCorrectionValue(correctedFieldValues[key]))
    ))) {
      return false
    }
    const now = new Date()
    const correctedPhotos = { ...requestToCorrect.requirementPhotos, ...correctionPhotos }
    const correctedFieldsByDocument = {}
    certificateFields.forEach(({ document, field, correctionKey }) => {
      if (!invalidKeys.includes(correctionKey)) return
      const currentDetails = correctedFieldsByDocument[document]
        || requestToCorrect.detailsByDocument?.[document]
        || requestToCorrect.certificateData?.[document]
        || requestToCorrect.details
        || {}
      const updatedDetails = {
        ...currentDetails,
        [field.key]: correctedFieldValues[correctionKey],
      }
      updatedDetails.purpose = getNormalizedRequestPurpose(
        updatedDetails,
        getCertificateTemplateFields(document, customCertificateTemplates),
      )
      correctedFieldsByDocument[document] = updatedDetails
    })
    const correctedDetailsByDocument = {
      ...(requestToCorrect.detailsByDocument || {}),
      ...correctedFieldsByDocument,
    }
    const correctedCertificateData = {
      ...(requestToCorrect.certificateData || {}),
      ...Object.fromEntries(Object.entries(correctedFieldsByDocument).map(([document, details]) => [
        document,
        { ...(requestToCorrect.certificateData?.[document] || {}), ...details },
      ])),
    }
    const correctedRequestDetails = Object.values(correctedFieldsByDocument).length === 1
      ? { ...(requestToCorrect.details || {}), ...Object.values(correctedFieldsByDocument)[0] }
      : requestToCorrect.details
    const correctedRequirements = getRequestPhotos({ requirementPhotos: correctedPhotos }).map((photo) => (
      `${photo.document ? `${photo.document} · ` : ''}${photo.label}: ${photo.fileName || 'Uploaded image'}`
    ))
    const correctedFieldLabels = certificateFields
      .filter(({ correctionKey }) => invalidKeys.includes(correctionKey))
      .map(({ field }) => field.label)
    const activityTime = now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id
      && currentRequest.status === 'Returned for edits'
      ? {
        ...currentRequest,
        status: 'For Verification',
        updatedAt: now.toISOString(),
        editRequestNote: '',
        invalidRequirements: [],
        requirementPhotos: correctedPhotos,
        requirements: correctedRequirements,
        ...(correctedFieldLabels.length ? {
          details: correctedRequestDetails,
          detailsByDocument: correctedDetailsByDocument,
          certificateData: correctedCertificateData,
        } : {}),
        correctedRequirementsAt: now.toISOString(),
        statusHistory: [...(currentRequest.statusHistory || []), { status: 'For Verification', changedAt: now.toISOString() }],
        activity: [...(currentRequest.activity || []), {
          action: `Corrected requirements resubmitted for review${correctedFieldLabels.length ? ` · Information updated: ${correctedFieldLabels.join(', ')}` : ''}`,
          by: 'Resident',
          time: activityTime,
        }],
      }
      : currentRequest))
    setSelectedInboxRequestId(null)
    return true
  }

  const handlePaymentProofChange = async (event) => {
    const file = event.target.files?.[0]
    if (!file) return
    setPaymentProofError('')
    setPaymentProof(null)
    setPaymentProofLoading(true)
    try {
      setPaymentProof(await createRequirementPhoto(file))
    } catch (error) {
      console.error('Unable to prepare a payment proof image.', error)
      setPaymentProofError(`${file.name}: ${error.message}`)
      event.target.value = ''
    } finally {
      setPaymentProofLoading(false)
    }
  }

  const finalizePaymentProofSubmission = (submittedRequests) => {
    const submittedRequestIds = new Set(submittedRequests.map((request) => request.id))
    const submittedRequestsById = new Map(submittedRequests.map((request) => [request.id, request]))
    const currentRequests = residentRequestsRef.current
    const existingRequestIds = new Set(currentRequests.map((request) => request.id))
    const updatedRequests = currentRequests.map((request) => submittedRequestsById.get(request.id) || request)
    const newlySubmittedRequests = submittedRequests.filter((request) => !existingRequestIds.has(request.id))
    const submittedRequestList = [...newlySubmittedRequests, ...updatedRequests]
    residentRequestsRef.current = submittedRequestList
    residentRequestSyncPauseUntilRef.current = Math.max(
      ...submittedRequests.map((request) => Date.parse(request.paymentSubmittedAt || '') || 0),
    ) + 10000
    setResidentRequests(submittedRequestList)
    saveResidentLocalRecord(residentRequestsStorageKey, submittedRequestList).catch((error) => {
      console.error('Unable to immediately save submitted payment requests in browser storage.', error)
      setDatabaseSaveError(`Payment requests could not be saved locally: ${error.message}`)
      setDatabaseSaveStatus('error')
    })
    setResidentPaymentDrafts((drafts) => drafts.filter((draft) => !submittedRequestIds.has(draft.id)))
    setSelectedPaymentRequestIds((requestIds) => requestIds.filter((requestId) => !submittedRequestIds.has(requestId)))
    setPaymentBatchOpen(false)
    setWalkInPaymentNoticeOpen(false)
    setPaymentMethod('')
    setPaymentProof(null)
    setPaymentProofOrNumber('')
    setPaymentProofError('')
    setPaymentSaveConfirmation(null)
    setResidentDashboardSection('requests')
    setSelectedInboxRequestId(null)
    setShowResidentCheck(false)
    setShowResidentInboxPage(true)
    setReturnToResidentDashboardAfterRequest(false)
  }

  const submitPaymentProof = (event, paymentRequests) => {
    event.preventDefault()
    if (paymentProofLoading) return
    const requests = Array.isArray(paymentRequests) ? paymentRequests : [paymentRequests]
    if (!requests.length) return
    if (hasStalePaymentSelection || requests.length !== selectedPaymentRequestIds.length) {
      setPaymentProofError('Your payment selection changed in another tab. Review the unpaid requests before submitting.')
      return
    }
    const receiptNumber = paymentProofOrNumber.trim()
    if (!paymentProof && !receiptNumber) {
      setPaymentProofError('Upload a receipt image or enter the OR/transaction number.')
      return
    }
    const submittedAt = new Date().toISOString()
    const activityTime = new Date(submittedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    const paymentGroupId = createResidentPaymentGroupId()
    const submittedRequests = requests.map((request) => {
      const submittedRequest = { ...request }
      delete submittedRequest.awaitingPaymentSubmission
      delete submittedRequest.paymentDraftedAt
      return {
        ...submittedRequest,
        requestedAt: request.requestedAt || submittedAt,
        status: request.status || 'New',
        paymentStatus: 'Pending verification',
        paymentMethod,
        paymentGroupId,
        paymentProof,
        paymentProofOrNumber: receiptNumber,
        paymentSubmittedAt: submittedAt,
        statusHistory: request.statusHistory || [{ status: 'New', changedAt: submittedAt }],
        activity: [
          ...(request.activity || (request.awaitingPaymentSubmission
            ? [{ action: 'Request submitted', by: 'Resident', time: activityTime }]
            : [])),
          {
            action: `Payment proof submitted${receiptNumber ? ` · ${receiptNumber}` : ''}`,
            by: 'Resident',
            time: activityTime,
          },
        ],
      }
    })
    setPaymentSaveConfirmation(submittedRequests)
  }

  const confirmPaymentProofSubmission = () => {
    if (!paymentSaveConfirmation) return
    const currentRequestsById = new Map(selectedResidentPaymentRequests.map((request) => [request.id, request]))
    const selectionChanged = paymentSaveConfirmation.some((request) => {
      const currentRequest = currentRequestsById.get(request.id)
      return !currentRequest || Number(currentRequest.feeAmount || 0) !== Number(request.feeAmount || 0)
    })
    if (selectionChanged) {
      setPaymentSaveConfirmation(null)
      setPaymentProofError('Your payment selection changed in another tab. Review the unpaid requests before submitting.')
      return
    }
    finalizePaymentProofSubmission(paymentSaveConfirmation)
  }

  const markRequestPaymentPaid = (request) => {
    const orNumber = paymentOrNumber.trim()
    if (!orNumber) return
    const now = new Date()
    const requestIds = new Set(request.requestIds || [request.id])
    const completePaymentGroup = adminPaymentRecords.find((payment) => (
      payment.groupKey === request.groupKey || payment.requestIds.some((requestId) => requestIds.has(requestId))
    ))
    const verifiedRequestIds = new Set(completePaymentGroup?.requestIds || requestIds)
    setResidentRequests((requests) => requests.map((currentRequest) => requestIds.has(currentRequest.id)
      || verifiedRequestIds.has(currentRequest.id)
      ? {
        ...currentRequest,
        paymentStatus: 'Paid',
        paymentOrNumber: orNumber,
        paymentVerifiedAt: now.toISOString(),
        paymentVerifiedBy: 'Barangay Secretary',
        activity: [...(currentRequest.activity || []), {
          action: `Payment marked paid · OR No. ${orNumber}`,
          by: 'Barangay Secretary',
          time: now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        }],
      }
      : currentRequest))
    setPaymentReviewRequestId('')
    setPaymentOrNumber('')
  }

  const addGcashRecipient = () => {
    if (gcashRecipientEditor) return
    setGcashRecipientError('')
    setGcashRecipientEditor({
      mode: 'add',
      recipient: {
        id: `gcash-recipient-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        displayName: '',
        mobileNumber: '',
      },
    })
  }

  const editGcashRecipient = (recipient) => {
    if (gcashRecipientEditor) return
    setGcashRecipientError('')
    setGcashRecipientEditor({ mode: 'edit', recipient: { ...recipient } })
  }

  const updateGcashRecipientDraft = (field, value) => {
    setGcashRecipientEditor((editor) => editor
      ? { ...editor, recipient: { ...editor.recipient, [field]: value } }
      : editor)
    setGcashRecipientError('')
  }

  const handleGcashQrUpload = async (event) => {
    const file = event.target.files?.[0]
    const editorId = gcashRecipientEditor?.recipient.id
    event.target.value = ''
    if (!file || !editorId) return

    setGcashQrUploadLoading(true)
    setGcashRecipientError('')
    try {
      const qrImage = await createGcashQrImage(file)
      setGcashRecipientEditor((editor) => editor?.recipient.id === editorId
        ? { ...editor, recipient: { ...editor.recipient, qrImage } }
        : editor)
    } catch (error) {
      setGcashRecipientError(error.message || 'The QR image could not be uploaded.')
    } finally {
      setGcashQrUploadLoading(false)
    }
  }

  const saveGcashRecipient = (event) => {
    event.preventDefault()
    if (!gcashRecipientEditor || gcashQrUploadLoading) return

    const recipient = {
      ...gcashRecipientEditor.recipient,
      displayName: gcashRecipientEditor.recipient.displayName.trim(),
      mobileNumber: gcashRecipientEditor.recipient.mobileNumber.trim(),
    }
    if (!recipient.displayName || !recipient.mobileNumber) {
      setGcashRecipientError('Enter both the account name and GCash mobile number before saving.')
      return
    }

    const updatedRecipients = gcashRecipientEditor.mode === 'add'
      ? [...gcashRecipients, recipient]
      : gcashRecipients.map((currentRecipient) => (
        currentRecipient.id === recipient.id ? recipient : currentRecipient
      ))
    if (!isValidGcashRecipientList(updatedRecipients)) {
      setGcashRecipientError('The combined QR images are too large to save. Use smaller QR images.')
      return
    }

    setGcashRecipients(updatedRecipients)
    setGcashRecipientEditor(null)
    setGcashRecipientError('')
  }

  const cancelGcashRecipientEdit = () => {
    if (gcashQrUploadLoading) return
    setGcashRecipientEditor(null)
    setGcashRecipientError('')
  }

  const removeGcashRecipient = (recipientId) => {
    setGcashRecipients((recipients) => recipients.filter((recipient) => recipient.id !== recipientId))
  }

  const uploadRefundProof = async (file) => {
    if (!file) {
      setRefundProof(null)
      setRefundProofError('')
      return
    }
    setRefundProofLoading(true)
    setRefundProof(null)
    setRefundProofError('')
    try {
      setRefundProof(await createCommunityUpdateImage(file))
    } catch (error) {
      setRefundProofError(error.message)
    } finally {
      setRefundProofLoading(false)
    }
  }

  const recordManualRefund = (event, request) => {
    event.preventDefault()
    const transactionNumber = refundTransactionNumber.trim()
    const destinationNumber = refundDestinationNumber.trim()
    if ((!transactionNumber && !refundProof) || !destinationNumber) {
      setRefundError('Enter the resident’s GCash number and provide a refund reference or proof image.')
      return
    }
    if (refundProofLoading) return
    if (request.status !== 'Cancelled' || request.paymentStatus !== 'Paid' || request.refundStatus === 'Refunded') {
      setRefundError('This request is no longer eligible for a refund record.')
      return
    }
    const refundedAt = new Date()
    setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id
      ? {
        ...currentRequest,
        refundStatus: 'Refunded',
        refundDestinationNumber: destinationNumber,
        refundTransactionNumber: transactionNumber,
        refundProof,
        refundNote: refundNote.trim(),
        refundedAt: refundedAt.toISOString(),
        activity: [...(currentRequest.activity || []), {
          action: `Manual GCash refund recorded${transactionNumber ? ` · ${transactionNumber}` : ' · proof attached'}`,
          by: 'Barangay Official',
          time: refundedAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }),
        }],
      }
      : currentRequest))
    setRefundRequestId('')
    setRefundTransactionNumber('')
    setRefundDestinationNumber('')
    setRefundProof(null)
    setRefundNote('')
    setRefundError('')
    setRefundProofError('')
  }

  const updateDocumentFee = (document, value) => {
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount < 0) return
    setDocumentFees((fees) => ({ ...fees, [document]: amount }))
  }

  const submitProfileUpdateRequest = (event) => {
    event.preventDefault()
    const proposedChanges = Object.fromEntries(Object.entries(profileUpdateForm).map(([key, value]) => [key, String(value || '').trim()]))
    if (Object.values(proposedChanges).every((value) => !value)) {
      setProfileUpdateError('Enter the updated information you would like the barangay office to review.')
      return
    }
    const request = {
      id: createResidentProfileUpdateId(),
      resident: fullName,
      residentCode: residentName.code.trim().toUpperCase(),
      proposedChanges,
      status: 'Pending',
      submittedAt: new Date().toISOString(),
    }
    setResidentProfileUpdateRequests((requests) => [request, ...requests])
    setProfileUpdateError('')
    setProfileUpdateFormOpen(false)
  }

  const reviewProfileUpdateRequest = async (request, status) => {
    if (!['Approved', 'Declined'].includes(status)) return
    const resident = adminResidents.find((candidate) => candidate.code?.toLowerCase() === request.residentCode.toLowerCase())
    const acceptedRegistration = registrationRequests.find((registration) => (
      registration.status === 'Approved'
      && registration.assignedResidentCode?.toLowerCase() === request.residentCode.toLowerCase()
    ))
    const isSharedRegistrationResident = Boolean(acceptedRegistration && !acceptedRegistration.backendRegistrationId)
    if (status === 'Approved' && (!resident || resident.recordStatus === 'inactive')) {
      setProfileUpdateError(`Could not find an active resident record ${request.residentCode}. The request was not approved.`)
      return
    }
    const reviewedAt = new Date().toISOString()
    if (status === 'Approved') {
      const approvedChanges = Object.fromEntries(
        Object.entries(request.proposedChanges || {}).filter(([, value]) => String(value || '').trim()),
      )
      if (officialBackendToken && !isSharedRegistrationResident) {
        try {
          await updateResidentAccountBackend(request.residentCode, 'update_profile', {
            changes: Object.fromEntries(Object.entries({
              date_of_birth: approvedChanges.birthDate,
              contact_number: approvedChanges.contactNumber,
              email: approvedChanges.emailAddress,
              address: approvedChanges.address,
            }).filter(([, value]) => value !== undefined)),
          })
        } catch (error) {
          console.error('Unable to apply approved resident profile changes to the database.', error)
          setProfileUpdateError(error.message || 'The profile changes were not applied to the database.')
          return
        }
      }
      setAdminResidents((residents) => residents.map((candidate) => candidate.code?.toLowerCase() === request.residentCode.toLowerCase()
        ? { ...candidate, ...approvedChanges, updatedAt: reviewedAt }
        : candidate))
      setRegistrationRequests((requests) => requests.map((registration) => registration.assignedResidentCode?.toLowerCase() === request.residentCode.toLowerCase()
        ? { ...registration, data: { ...(registration.data || {}), ...approvedChanges }, address: approvedChanges.address || registration.address }
        : registration))
    }
    setResidentProfileUpdateRequests((requests) => requests.map((candidate) => candidate.id === request.id
      ? { ...candidate, status, reviewedAt }
      : candidate))
    setProfileUpdateError('')
    if (status === 'Approved' && (!officialBackendToken || isSharedRegistrationResident)) {
      setResidentAccountMessage(isSharedRegistrationResident
        ? 'Profile update approved for this resident in shared Resident Records.'
        : 'Profile update approved in shared app data. Database sign-in profile changes require an authorized backend admin session.')
    }
  }

  const submitOfficialLogin = async (event) => {
    event.preventDefault()
    const enteredEmail = officialCredentials.username.trim().toLowerCase()
    if (!enteredEmail || !officialCredentials.password) {
      setLoginStatus('Enter your backend admin email and password.')
      return
    }

    setOfficialBackendToken('')
    databaseRecordsRef.current = null
    setDatabaseSaveStatus('checking')
    setDatabaseSaveError('')
    setAdminRecoveryMessage('')
    try {
      const response = await fetch(`${BACKEND_API_URL}/login.php`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: enteredEmail, password: officialCredentials.password }),
      })
      const result = await response.json()
      if (!response.ok || !result.success || !result.token || !['admin', 'official'].includes(result.data?.role)) {
        setLoginStatus(result.message || 'Sign-in failed. Use an active backend admin or official account.')
        setOfficialCredentials({ username: '', password: '' })
        return
      }
      setOfficialBackendToken(result.token)
    } catch (error) {
      console.error('Unable to authenticate admin with the resident database service.', error)
      setLoginStatus('Unable to reach the resident database service. Check that the backend is running, then try again.')
      setOfficialCredentials({ username: '', password: '' })
      return
    }

    setOfficialCredentials({ username: '', password: '' })
    setLoginStatus('')
    setShowOfficialLogin(false)
    setShowOfficialDashboard(true)
  }

  const logoutOfficial = () => {
    setOfficialBackendToken('')
    setShowOfficialDashboard(false)
    setShowOfficialLogin(false)
    returnHome()
  }

  useEffect(() => {
    if (!showOfficialDashboard || autoLogoutMinutes === 0) return undefined

    let timeoutId
    const resetInactivityTimer = () => {
      window.clearTimeout(timeoutId)
      timeoutId = window.setTimeout(() => {
        setShowOfficialDashboard(false)
        setShowOfficialLogin(false)
        setAdminView('overview')
        setProfileOpen(false)
        setNotificationsOpen(false)
      }, autoLogoutMinutes * 60 * 1000)
    }
    const activityEvents = ['pointerdown', 'keydown', 'touchstart', 'mousemove']
    activityEvents.forEach((eventName) => window.addEventListener(eventName, resetInactivityTimer, { passive: true }))
    resetInactivityTimer()

    return () => {
      window.clearTimeout(timeoutId)
      activityEvents.forEach((eventName) => window.removeEventListener(eventName, resetInactivityTimer))
    }
  }, [autoLogoutMinutes, showOfficialDashboard])

  const recordPrintedDocument = (request, document, certificateData) => {
    const printedDocuments = { ...getUnchangedPrintedDocuments(request, certificateData), [document]: true }
    const changedAt = new Date()
    const updatedRequest = {
      ...request,
      certificateData,
      printedDocuments,
      activity: [...(request.activity || []), {
        action: `${document} marked ready for release`,
        by: 'Barangay Official',
        time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      }],
    }

    if (request.documents.every((requestedDocument) => printedDocuments[requestedDocument])) {
      const completedProcessingRequest = {
        ...updatedRequest,
        status: 'Ready for release',
        statusHistory: request.status === 'Ready for release'
          ? updatedRequest.statusHistory
          : [...(request.statusHistory || []), { status: 'Ready for release', changedAt: changedAt.toISOString() }],
        printCompletedAt: changedAt.toISOString(),
        activity: [...updatedRequest.activity, {
          action: 'All requested documents are prepared and ready for release',
          by: 'Barangay Official',
          time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        }],
      }
      setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id ? completedProcessingRequest : currentRequest))
      setSelectedRequestId(null)
      setDocumentQueueFilter('release')
      return
    }

    setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id ? updatedRequest : currentRequest))
  }

  const startReadyForRelease = (request) => {
    setReadyForm({
      requestId: request.id,
      pickupDate: /^\d{4}-\d{2}-\d{2}$/.test(request.pickupDate || '') ? request.pickupDate : '',
      pickupTime: request.pickupTime || '',
      pickupInstructions: request.pickupInstructions || '',
    })
    setReadyFormError('')
    setIsReviewingReadyForm(false)
  }

  const setRequestReadyForRelease = (event, request) => {
    event.preventDefault()
    if (readyForm.requestId !== request.id || request.status !== 'Ready for release') return
    const pickupInstructions = readyForm.pickupInstructions.trim()
    const pickupDateTime = new Date(`${readyForm.pickupDate}T${readyForm.pickupTime}`)
    if (!readyForm.pickupDate || !readyForm.pickupTime || Number.isNaN(pickupDateTime.getTime()) || pickupDateTime <= new Date()) {
      setReadyFormError('Choose a future pickup date and time before notifying the resident.')
      return
    }
    if (!pickupInstructions) {
      setReadyFormError('Enter the pickup location and any instructions before notifying the resident.')
      return
    }

    setReadyForm({ requestId: request.id, pickupDate: readyForm.pickupDate, pickupTime: readyForm.pickupTime, pickupInstructions })
    setReadyFormError('')
    setIsReviewingReadyForm(true)
  }

  const closeReadyForRelease = () => {
    setReadyForm({ requestId: '', pickupDate: '', pickupTime: '', pickupInstructions: '' })
    setReadyFormError('')
    setIsReviewingReadyForm(false)
  }

  const sendPickupDetails = (request) => {
    if (readyForm.requestId !== request.id || request.status !== 'Ready for release') return
    const pickupDateTime = new Date(`${readyForm.pickupDate}T${readyForm.pickupTime}`)
    if (!readyForm.pickupInstructions.trim() || Number.isNaN(pickupDateTime.getTime()) || pickupDateTime <= new Date()) {
      setReadyFormError('Pickup details are no longer valid. Edit the schedule and review it again.')
      setIsReviewingReadyForm(false)
      return
    }
    const changedAt = new Date()
    const pickupDate = readyForm.pickupDate
    const pickupTime = readyForm.pickupTime
    const pickupInstructions = readyForm.pickupInstructions.trim()
    const scheduleLabel = `${pickupDateTime.toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' })} · ${pickupInstructions}`
    const isScheduleUpdate = Boolean(request.pickupNotificationSentAt)
    const updatedRequest = {
      ...request,
      status: 'Ready for release',
      pickupDate,
      pickupTime,
      pickupInstructions,
      pickupNotificationSentAt: changedAt.toISOString(),
      statusHistory: request.statusHistory || [],
      activity: [...(request.activity || []), {
        action: `${isScheduleUpdate ? 'Pickup information updated and sent' : 'Pickup information sent'}: ${scheduleLabel}`,
        by: 'Barangay Official',
        time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      }],
    }
    setResidentRequests((requests) => requests.map((currentRequest) => currentRequest.id === request.id ? updatedRequest : currentRequest))
    closeReadyForRelease()
    setSelectedRequestId(null)
    setDocumentQueueFilter('release')
  }

  const markRequestAsReceived = (request, releaseDetails) => {
    if (request.status !== 'Ready for release') {
      setReleaseFormError('This request is no longer ready for release. Refresh the request list and try again.')
      return false
    }
    if (issuedDocuments.some((entry) => entry.requestId === request.id)) {
      setReleaseFormError('This request has already been recorded as received.')
      return false
    }

    const releasedTo = releaseDetails.releasedTo.trim()
    const orNumber = releaseDetails.orNumber.trim()
    const issuingOfficer = releaseDetails.issuingOfficer.trim()
    if (!releasedTo || !orNumber || !issuingOfficer) {
      setReleaseFormError('Enter the recipient, OR number (or N/A), and issuing officer before releasing.')
      return false
    }

    const releasedAt = new Date()
    const yearPrefix = `BB1-${releasedAt.getFullYear()}-`
    let nextSequence = issuedDocuments.reduce((highest, entry) => {
      if (!entry.controlNumber?.startsWith(yearPrefix)) return highest
      const sequence = Number(entry.controlNumber.slice(yearPrefix.length))
      return Number.isFinite(sequence) ? Math.max(highest, sequence) : highest
    }, 0) + 1
    const newEntries = request.documents.map((document) => {
      const entry = {
        id: `${request.id}-${document.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        controlNumber: `${yearPrefix}${String(nextSequence).padStart(6, '0')}`,
        requestId: request.id,
        resident: request.resident,
        residentCode: request.residentCode || '',
        document,
        status: 'Received',
        date: releasedAt.toISOString(),
        purpose: request.detailsByDocument?.[document]?.purpose || request.details?.purpose || 'Not provided',
        orNumber,
        issuingOfficer,
        releasedTo,
      }
      nextSequence += 1
      return entry
    })
    const completedRequest = {
      ...request,
      status: 'Completed',
      releasedAt: releasedAt.toISOString(),
      releasedTo,
      orNumber,
      issuingOfficer,
      statusHistory: [...(request.statusHistory || []), { status: 'Completed', changedAt: releasedAt.toISOString() }],
      activity: [...(request.activity || []), {
        action: `Documents marked received by ${releasedTo}; OR ${orNumber}`,
        by: issuingOfficer,
        time: releasedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
      }],
    }
    setIssuedDocuments((entries) => [
      ...newEntries.filter((newEntry) => !entries.some((entry) => entry.id === newEntry.id)),
      ...entries,
    ])
    setResidentRequests((requests) => requests.filter((currentRequest) => currentRequest.id !== request.id))
    setResidentHistory((history) => [
      createDocumentRequestHistoryEntry(completedRequest),
      ...history.filter((entry) => entry.requestId !== request.id),
    ])
    setReleaseForm({ requestId: '', releasedTo: '', orNumber: '', issuingOfficer: '' })
    setReleaseFormError('')
    setSelectedRequestId(null)
    markAdminViewRead('issuedDocuments')
    setAdminView('issuedDocuments')
    return true
  }

  const releaseRequest = (event, request) => {
    event.preventDefault()
    if (releaseForm.requestId !== request.id) {
      setReleaseFormError('This release form is no longer current. Refresh the request and try again.')
      return
    }
    markRequestAsReceived(request, releaseForm)
  }

  const toggleCertificateType = (document) => {
    setEnabledCertificateTypes((documents) => documents.includes(document)
      ? documents.filter((enabledDocument) => enabledDocument !== document)
      : [...documents, document])
  }

  const resetCustomTemplateForm = () => {
    setEditingCertificateTemplate('')
    setEditingCustomTemplateId('')
    setCustomTemplateName('')
    setCustomTemplateFile(null)
    setCustomTemplatePreserveHeader(false)
    setCustomTemplateDetectedFields([])
    setCustomTemplateRequirements('Valid government ID')
    setCustomTemplateError('')
    setCustomTemplateStatus('')
    setIsCustomTemplatePreviewOpen(false)
    setIsCertificateTemplateEditorOpen(false)
  }

  const openCertificateTemplateEditor = (document) => {
    const template = getCertificateTemplate(document, customCertificateTemplates)
    if (!template) return
    setEditingCertificateTemplate(document)
    setCustomTemplateError('')
    setCustomTemplateStatus('')
    setIsCustomTemplateFormOpen(false)
    setIsCustomTemplatePreviewOpen(false)
    setIsCertificateTemplateEditorOpen(true)
  }

  const applyCertificateTemplateEditorChanges = async (file, reviewedFields) => {
    const name = editingCertificateTemplate
    const existingCustomTemplate = customCertificateTemplates.find((template) => template.name === name)
    const currentTemplate = getCertificateTemplate(name, customCertificateTemplates)
    if (!name || !currentTemplate) throw new Error('The certificate template is no longer available. Close the editor and reopen it.')
    if (!reviewedFields) {
      let detectedFields = []
      try {
        detectedFields = await scanCertificateTemplateFields(file)
      } catch (scanError) {
        if (!/No fillable blank fields, checkbox options, or text boxes were found/i.test(scanError.message || '')) throw scanError
      }
      return matchEditedCertificateFields(detectedFields, currentTemplate.fields || [])
    }

    if (reviewedFields.some((field) => field.needsReview || !String(field.label || '').trim())) {
      throw new Error('Review every new or uncertain resident field before saving the template.')
    }
    if (!isDatabaseConnected) throw new Error('Connect to the application database before saving a template.')
    const contentBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const separator = result.indexOf(',')
        if (separator < 0) reject(new Error('The edited DOCX could not be encoded for online storage.'))
        else resolve(result.slice(separator + 1))
      }
      reader.onerror = () => reject(reader.error || new Error('The edited DOCX could not be read.'))
      reader.readAsDataURL(file)
    })
    const usedStorage = customCertificateTemplates
      .filter((template) => template.id !== existingCustomTemplate?.id)
      .reduce((total, template) => total + template.contentBase64.length, 0)
    if (usedStorage + contentBase64.length > 5000000) {
      throw new Error('The custom certificate templates exceed the 5 MB shared-storage limit. Use a smaller DOCX file.')
    }
    const now = new Date().toISOString()
    const updatedTemplate = {
      ...existingCustomTemplate,
      id: existingCustomTemplate?.id || createCustomCertificateTemplateId(),
      name,
      originalFilename: file.name,
      contentBase64,
      custom: true,
      preserveHeader: true,
      overridesBuiltIn: Boolean(existingCustomTemplate?.overridesBuiltIn || (!existingCustomTemplate && getCertificateTemplate(name, []))),
      fields: reviewedFields,
      requirements: existingCustomTemplate?.requirements || currentTemplate.requirements || getDocumentRequirements(name, customCertificateTemplates),
      createdAt: existingCustomTemplate?.createdAt || now,
      updatedAt: now,
    }
    const nextTemplates = existingCustomTemplate
      ? customCertificateTemplates.map((template) => template.id === existingCustomTemplate.id ? updatedTemplate : template)
      : [...customCertificateTemplates, updatedTemplate]
    await saveDatabaseRecords({ [certificateTemplatesStorageKey]: nextTemplates }, officialBackendToken)
    setCustomCertificateTemplates(nextTemplates)
    setCustomTemplateError('')
    setCustomTemplateStatus(`The layout for “${name}” was saved online. Existing proof-document requirements, requests, fees, and availability settings were kept.`)
    return true
  }

  const applyNewCertificateTemplateEditorChanges = async (file, reviewedFields) => {
    if (!reviewedFields) {
      const detectedFields = await scanCertificateTemplateFields(file)
      if (!detectedFields.length) {
        throw new Error('The new document needs at least one fillable blank or checkbox before it can be posted.')
      }
      return matchEditedCertificateFields(detectedFields, customTemplateDetectedFields)
    }
    if (reviewedFields.some((field) => field.needsReview || !String(field.label || '').trim())) {
      throw new Error('Review every new or uncertain resident field before returning to the document form.')
    }
    setCustomTemplateFile(file)
    setCustomTemplatePreserveHeader(true)
    setCustomTemplateDetectedFields(reviewedFields)
    setCustomTemplateError('')
    setCustomTemplateStatus('Edited layout is ready. Save the document form to post this template for residents.')
    return true
  }

  const startAddingCustomCertificateTemplate = () => {
    resetCustomTemplateForm()
    setIsCustomTemplateFormOpen(true)
  }

  const inspectCustomCertificateFile = async (file, { preserveHeader = false } = {}) => {
    setCustomTemplateError('')
    setCustomTemplateStatus('')
    setIsCustomTemplatePreviewOpen(false)
    setCustomTemplateFile(null)
    setCustomTemplatePreserveHeader(preserveHeader)
    setCustomTemplateDetectedFields([])
    if (!file) return false
    if (!file.name.toLowerCase().endsWith('.docx')) {
      setCustomTemplateError('Choose a Microsoft Word DOCX template.')
      return false
    }
    if (file.size > 1500000) {
      setCustomTemplateError('DOCX templates must be 1.5 MB or smaller.')
      return false
    }
    setCustomTemplateStatus(preserveHeader ? 'Checking the edited DOCX and scanning its resident fields…' : 'Applying the standard barangay header and scanning the document…')
    try {
      const preparedBlob = preserveHeader ? file : await normalizeCertificateTemplateHeader(file, file.name)
      const standardizedFile = new File([preparedBlob], file.name, {
        type: file.type || 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      })
      setCustomTemplateFile(standardizedFile)
      const fields = await scanCertificateTemplateFields(standardizedFile)
      if (!fields.length) {
        setCustomTemplateFile(null)
        setCustomTemplateDetectedFields([])
        setCustomTemplateError('The edited DOCX has no fillable fields. The template must include a detectable blank or checkbox before it can be saved.')
        return false
      }
      setCustomTemplateDetectedFields(fields)
      const blankCount = fields.filter((field) => field.type !== 'checkbox').length
      const checkboxOptions = fields.filter((field) => field.type === 'checkbox')
      const checkboxGroupCount = new Set(checkboxOptions.map((field) => field.groupId)).size
      const reviewCount = fields.filter((field) => field.needsReview).length
      setCustomTemplateStatus(`${blankCount} blank fields and ${checkboxOptions.length} checkbox choices in ${checkboxGroupCount} groups detected. ${reviewCount ? `${reviewCount} label${reviewCount === 1 ? '' : 's'} need review. ` : ''}Signature lines are excluded.`)
      return true
    } catch (error) {
      console.error('Unable to inspect the uploaded certificate template.', error)
      setCustomTemplateFile(null)
      setCustomTemplateDetectedFields([])
      setCustomTemplateError(error.message || 'The uploaded DOCX template could not be scanned.')
      return false
    }
  }

  const updateCustomTemplateFieldLabel = (group, value) => {
    const targetKeys = new Set(group.targets.map((target) => target.key).filter(Boolean))
    const normalizedLabel = value.trim().toLowerCase()
    const needsReview = !normalizedLabel || ['please identify this field', 'select an option'].includes(normalizedLabel)
    setCustomTemplateDetectedFields((fields) => fields.map((field) => (
      targetKeys.has(field.key)
        ? {
          ...field,
          label: value,
          needsReview,
          labelConfidence: needsReview ? 'low' : 'reviewed',
        }
        : field
    )))
  }

  const saveCustomCertificateTemplate = async (event) => {
    event.preventDefault()
    setCustomTemplateError('')
    setCustomTemplateStatus('')
    const isEditing = Boolean(editingCertificateTemplate)
    const name = isEditing ? editingCertificateTemplate : customTemplateName.trim()
    if (name.length < 3 || name.length > 80) {
      setCustomTemplateError('Enter a document name between 3 and 80 characters.')
      return
    }
    if (!isEditing && allCertificateDocuments.some((document) => document.toLowerCase() === name.toLowerCase())) {
      setCustomTemplateError('A certificate template with this document name already exists.')
      return
    }
    const templateToReplace = editingCustomTemplateId
      ? customCertificateTemplates.find((template) => template.id === editingCustomTemplateId)
      : null
    if (editingCustomTemplateId && !templateToReplace) {
      setCustomTemplateError('This template changed while the editor was open. Close the form and reopen the template before updating it.')
      return
    }
    if (!customTemplateFile || !customTemplateDetectedFields.length) {
      setCustomTemplateError('Upload a DOCX template with at least one automatically detected blank, checkbox, or text box.')
      return
    }
    if (customTemplateDetectedFields.some((field) => field.needsReview || !field.label.trim())) {
      setCustomTemplateError('Review and give a clear resident-facing label to every field marked “Needs review” before saving.')
      return
    }
    const requirements = [...new Set(customTemplateRequirements.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))]
    if (!requirements.length || requirements.some((requirement) => requirement.length > 100)) {
      setCustomTemplateError('Enter at least one proof requirement. Each requirement must be 100 characters or fewer.')
      return
    }
    if (!isDatabaseConnected) {
      setCustomTemplateError('Connect to the application database before saving a template so it is preserved for residents and staff.')
      return
    }

    setIsSavingCustomTemplate(true)
    try {
      const contentBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = String(reader.result || '')
          const separator = result.indexOf(',')
          if (separator < 0) reject(new Error('The DOCX file could not be encoded for storage.'))
          else resolve(result.slice(separator + 1))
        }
        reader.onerror = () => reject(reader.error || new Error('The DOCX file could not be read.'))
        reader.readAsDataURL(customTemplateFile)
      })
      const usedTemplateStorage = customCertificateTemplates
        .filter((template) => template.id !== templateToReplace?.id)
        .reduce((total, template) => total + template.contentBase64.length, 0)
      if (usedTemplateStorage + contentBase64.length > 5000000) {
        throw new Error('The custom certificate templates exceed the 5 MB shared-storage limit. Remove an unused template or use a smaller DOCX file.')
      }
      const isBuiltInTemplate = Boolean(getCertificateTemplate(name, []))
      const template = {
        ...templateToReplace,
        id: templateToReplace?.id || createCustomCertificateTemplateId(),
        name,
        originalFilename: customTemplateFile.name,
        contentBase64,
        custom: true,
        preserveHeader: customTemplatePreserveHeader,
        overridesBuiltIn: Boolean(templateToReplace?.overridesBuiltIn || (!templateToReplace && isBuiltInTemplate)),
        fields: customTemplateDetectedFields,
        requirements,
        createdAt: templateToReplace?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      const nextTemplates = templateToReplace
        ? customCertificateTemplates.map((item) => item.id === templateToReplace.id ? template : item)
        : [...customCertificateTemplates, template]
      const nextEnabledTemplates = isEditing
        ? enabledCertificateTypes
        : [...new Set([...enabledCertificateTypes, name])]
      const nextFees = isEditing ? documentFees : { ...documentFees, [name]: 0 }
      await saveDatabaseRecords({
        [certificateTemplatesStorageKey]: nextTemplates,
        [enabledCertificateTypesStorageKey]: nextEnabledTemplates,
        [documentFeesStorageKey]: nextFees,
      }, officialBackendToken)
      setCustomCertificateTemplates(nextTemplates)
      setEnabledCertificateTypes(nextEnabledTemplates)
      setDocumentFees(nextFees)
      setCustomTemplateName('')
      setEditingCertificateTemplate('')
      setEditingCustomTemplateId('')
      setCustomTemplateFile(null)
      setCustomTemplatePreserveHeader(false)
      setCustomTemplateDetectedFields([])
      setCustomTemplateRequirements('Valid government ID')
      setCustomTemplateStatus(isEditing
        ? `The layout for “${name}” was updated. Existing request and fee records were kept.`
        : `“${name}” was saved and is available to residents.`)
      setIsCustomTemplatePreviewOpen(false)
      setIsCustomTemplateFormOpen(false)
      setPreviewTemplateDocument(name)
    } catch (error) {
      console.error('Unable to save the custom certificate template.', error)
      setCustomTemplateError(error.message || 'The certificate template could not be saved to the database.')
    } finally {
      setIsSavingCustomTemplate(false)
    }
  }

  const restoreBuiltInCertificateTemplate = async (template) => {
    if (!isDatabaseConnected) {
      setCustomTemplateError('Connect to the application database before restoring a template.')
      return
    }
    if (!window.confirm(`Restore the original built-in layout for “${template.name}”? Existing requests, fees, and availability settings will be kept.`)) return
    const nextTemplates = customCertificateTemplates.filter((item) => item.id !== template.id)
    try {
      await saveDatabaseRecords({
        [certificateTemplatesStorageKey]: nextTemplates,
      }, officialBackendToken)
      setCustomCertificateTemplates(nextTemplates)
      setCustomTemplateError('')
      setCustomTemplateStatus(`The original layout for “${template.name}” was restored. Existing request records were kept.`)
    } catch (error) {
      console.error(`Unable to restore the built-in ${template.name} template.`, error)
      setCustomTemplateError(error.message || 'The original template could not be restored.')
    }
  }

  const deleteCustomCertificateTemplate = async (template) => {
    const processingRequests = residentRequests.filter((request) => (
      request.status === 'Approved - scheduling'
      && request.documents?.includes(template.name)
      && !request.printedDocuments?.[template.name]
    ))
    if (processingRequests.length) {
      setCustomTemplateError(`“${template.name}” still has ${processingRequests.length} certificate${processingRequests.length === 1 ? '' : 's'} in Processing Requests. Complete or remove those requests before deleting the template.`)
      return
    }
    const usesTemplate = (request) => request.documents?.includes(template.name)
    const relatedRequestIds = new Set([
      ...residentRequests.filter(usesTemplate).map((request) => request.id),
      ...residentHistory
        .filter((entry) => entry.type === 'documentRequest' && usesTemplate(entry.request || {}))
        .map((entry) => entry.requestId || entry.request?.id)
        .filter(Boolean),
    ])
    const relatedRecordCount = relatedRequestIds.size
    if (!isDatabaseConnected) {
      setCustomTemplateError('Connect to the application database before deleting a template.')
      return
    }
    const nextTemplates = customCertificateTemplates.filter((item) => item.id !== template.id)
    const nextEnabledTemplates = enabledCertificateTypes.filter((document) => document !== template.name)
    const nextFees = { ...documentFees }
    delete nextFees[template.name]
    const nextRequests = residentRequests.filter((request) => !usesTemplate(request))
    const nextHistory = residentHistory.filter((entry) => !(
      entry.type === 'documentRequest' && usesTemplate(entry.request || {})
    ))
    const nextPaymentDrafts = residentPaymentDrafts.filter((request) => (
      !relatedRequestIds.has(request.id) && !usesTemplate(request)
    ))
    const nextIssuedDocuments = issuedDocuments.filter((entry) => entry.document !== template.name)
    const nextResidentDrafts = residentDrafts.filter((draft) => !usesTemplate(draft))
    const relatedPaymentDraftCount = residentPaymentDrafts.length - nextPaymentDrafts.length
    const relatedResidentDraftCount = residentDrafts.length - nextResidentDrafts.length
    if (!window.confirm(
      `Delete the add-only “${template.name}” template, ${relatedRecordCount} related request/history record${relatedRecordCount === 1 ? '' : 's'}, ${relatedPaymentDraftCount} payment draft${relatedPaymentDraftCount === 1 ? '' : 's'}, and ${relatedResidentDraftCount} saved request draft${relatedResidentDraftCount === 1 ? '' : 's'}? Other document types will not be deleted. This cannot be undone.`,
    )) return
    const previousDeletedRequestIds = window.localStorage.getItem(residentRequestDeletionsStorageKey)
    const savedDeletedRequestIds = readStoredList(residentRequestDeletionsStorageKey, [])
    const nextDeletedRequestIds = [...new Set([...savedDeletedRequestIds, ...relatedRequestIds])]
    try {
      window.localStorage.setItem(residentRequestDeletionsStorageKey, JSON.stringify(nextDeletedRequestIds))
      await saveDatabaseRecords({
        [certificateTemplatesStorageKey]: nextTemplates,
        [enabledCertificateTypesStorageKey]: nextEnabledTemplates,
        [documentFeesStorageKey]: nextFees,
        [residentRequestsStorageKey]: nextRequests,
        [residentRequestDeletionsStorageKey]: nextDeletedRequestIds,
        [residentHistoryStorageKey]: nextHistory,
        [residentPaymentDraftsStorageKey]: nextPaymentDrafts,
        [issuedDocumentsStorageKey]: nextIssuedDocuments,
      }, officialBackendToken)
      setCustomCertificateTemplates(nextTemplates)
      setEnabledCertificateTypes(nextEnabledTemplates)
      setDocumentFees(nextFees)
      residentRequestsRef.current = nextRequests
      residentHistoryRef.current = nextHistory
      residentPaymentDraftsRef.current = nextPaymentDrafts
      setResidentRequests(nextRequests)
      setResidentHistory(nextHistory)
      setResidentPaymentDrafts(nextPaymentDrafts)
      setIssuedDocuments(nextIssuedDocuments)
      setResidentDrafts(nextResidentDrafts)
      if (relatedRequestIds.has(selectedRequestId)) setSelectedRequestId(null)
      setCustomTemplateError('')
      setCustomTemplateStatus(`“${template.name}” and ${relatedRecordCount} related request/history record${relatedRecordCount === 1 ? '' : 's'} were deleted.`)
    } catch (error) {
      if (previousDeletedRequestIds === null) {
        window.localStorage.removeItem(residentRequestDeletionsStorageKey)
      } else {
        window.localStorage.setItem(residentRequestDeletionsStorageKey, previousDeletedRequestIds)
      }
      console.error(`Unable to delete the ${template.name} certificate template.`, error)
      setCustomTemplateError(error.message || 'The certificate template could not be deleted.')
    }
  }

  const exportDocumentReport = () => {
    const quoteCsv = (value) => {
      const safeValue = String(value ?? '')
      const protectedValue = /^[\s]*[=+\-@]/.test(safeValue) ? `'${safeValue}` : safeValue
      return `"${protectedValue.replace(/"/g, '""')}"`
    }
    const rows = [
      ['Month', 'Document type', 'Status', 'Count'],
      ...documentReportRows.map(({ month, document, status, count }) => [month, document, status, count]),
    ]
    const csv = rows.map((row) => row.map(quoteCsv).join(',')).join('\r\n')
    const file = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const objectUrl = URL.createObjectURL(file)
    const link = window.document.createElement('a')
    link.href = objectUrl
    link.download = `document-request-report-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(objectUrl)
  }

  const markDocumentWorkflowViewed = useCallback((request) => {
    const token = getDocumentWorkflowViewToken(request)
    if (documentWorkflowViewedStateRef.current[request.id] === token) return
    const nextViewedState = { ...documentWorkflowViewedStateRef.current, [request.id]: token }
    documentWorkflowViewedStateRef.current = nextViewedState
    setDocumentWorkflowViewedState(nextViewedState)
    try {
      window.localStorage.setItem(documentWorkflowViewedStorageKey, JSON.stringify(nextViewedState))
    } catch (error) {
      console.error('Unable to save document workflow view state.', error)
    }
  }, [])

  useEffect(() => {
    const syncViewedState = (event) => {
      if (event.key !== documentWorkflowViewedStorageKey || !event.newValue) return
      try {
        const viewedState = JSON.parse(event.newValue)
        if (!viewedState || typeof viewedState !== 'object' || Array.isArray(viewedState)
          || !Object.values(viewedState).every((token) => typeof token === 'string')) {
          throw new Error('Saved document workflow view state is invalid.')
        }
        documentWorkflowViewedStateRef.current = viewedState
        setDocumentWorkflowViewedState(viewedState)
      } catch (error) {
        console.error('Unable to sync document workflow view state.', error)
      }
    }
    window.addEventListener('storage', syncViewedState)
    return () => window.removeEventListener('storage', syncViewedState)
  }, [])

  useEffect(() => {
    if (!showOfficialDashboard) return
    if (adminView === 'documents' && selectedRequestId) {
      const request = residentRequestsRef.current.find((item) => item.id === selectedRequestId)
      if (request) markDocumentWorkflowViewed(request)
    }
    if (adminView === 'certificateProcessing' && certificateProcessingRequestId) {
      const request = residentRequestsRef.current.find((item) => item.id === certificateProcessingRequestId)
      if (request) markDocumentWorkflowViewed(request)
    }
  }, [adminView, certificateProcessingRequestId, markDocumentWorkflowViewed, selectedRequestId, showOfficialDashboard])

  const recordAction = (requestId, action) => {
    const changedAt = new Date()
    const nextStatusByAction = {
      'Started review': 'Under review',
      'Approved and forwarded to document processing': 'Approved - scheduling',
      'Reopened for review': 'Under review',
    }
    const nextStatus = nextStatusByAction[action]
    const request = residentRequestsRef.current.find((currentRequest) => currentRequest.id === requestId)
    const paymentVerified = Number(request?.feeAmount || 0) <= 0 || request?.paymentStatus === 'Paid'
    const hasPreparedDocument = Boolean(request?.printCompletedAt)
      || (request?.documents || []).some((document) => request?.printedDocuments?.[document])
    const allowedAction = paymentVerified
      && ((action === 'Started review' && ['New', 'For Verification'].includes(request?.status))
        || (action === 'Approved and forwarded to document processing' && request?.status === 'Under review')
        || (action === 'Reopened for review' && request?.status === 'Approved - scheduling' && !hasPreparedDocument))
    if (request && nextStatus && allowedAction) {
      const statusHistory = nextStatus && request.status !== nextStatus
        ? [...(request.statusHistory || []), { status: nextStatus, changedAt: changedAt.toISOString() }]
        : request.statusHistory || []
      const updatedRequest = {
        ...request,
        status: nextStatus || request.status,
        ...(nextStatus === 'Under review' ? { editRequestNote: '' } : {}),
        statusHistory,
        ...(nextStatus === 'Approved - scheduling' ? {
          documentsApprovedAt: changedAt.toISOString(),
          certificateData: request.certificateData || getDefaultRequestCertificates(request, customCertificateTemplates),
        } : {}),
        activity: [...(request.activity || []), { action, by: 'Barangay Official', time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }],
      }
      const updatedRequests = residentRequestsRef.current.map((currentRequest) => (
        currentRequest.id === requestId ? updatedRequest : currentRequest
      ))
      residentRequestsRef.current = updatedRequests
      residentRequestSyncPauseUntilRef.current = changedAt.getTime() + 10000
      setResidentRequests(updatedRequests)
    }
    if (action === 'Started review' && allowedAction) {
      setDocumentQueueFilter('review')
      setSelectedRequestId(null)
      setRequestSearch('')
      setRequestDocumentFilter('all')
      markAdminNavigationSectionRead('documents')
      setAdminView('documents')
    }
    if (action === 'Reopened for review' && allowedAction) {
      setCertificateProcessingRequestId(null)
      setCertificateProcessingRequestGroupIds([])
      setCertificateProcessingDocument(null)
      setDocumentQueueFilter('review')
      setSelectedRequestId(requestId)
      setRequestSearch('')
      setRequestDocumentFilter('all')
      markAdminNavigationSectionRead('documents')
      setAdminView('documents')
    }
    if (nextStatus === 'Approved - scheduling') {
      setSelectedRequestId(null)
      setCertificateProcessingRequestId(requestId)
      setCertificateProcessingRequestGroupIds([requestId])
      setCertificateProcessingDocument(null)
      setHighlightedCertificateTemplate(request && allowedAction ? getCertificateTemplateTarget(request) : null)
      setDocumentQueueFilter('processing')
      markAdminViewRead('certificateTemplates')
      setAdminView('certificateTemplates')
    }
  }

  const getCurrentCertificateData = (request) => Object.fromEntries(
    request.documents.map((document) => [document, getSubmittedCertificateData(request, document)]),
  )

  const updateStoredRequest = (requestId, update) => {
    if (residentRequests.some((request) => request.id === requestId)) {
      setResidentRequests((requests) => requests.map((request) => request.id === requestId ? update(request) : request))
      return
    }

    setResidentHistory((history) => history.map((entry) => entry.type === 'documentRequest' && entry.requestId === requestId
      ? { ...entry, request: update(entry.request) }
      : entry))
  }

  const saveCertificateReview = (request) => {
    const certificateData = getCurrentCertificateData(request)
    updateStoredRequest(request.id, (currentRequest) => {
      const requestedCopyCount = Number(currentRequest.copyCount ?? request.copyCount)
      const previousCopyCount = Number(currentRequest.copyCount ?? 1)
      const copyCountChanged = previousCopyCount !== requestedCopyCount
      return {
        ...currentRequest,
        certificateData,
        copyCount: Number.isSafeInteger(requestedCopyCount) && requestedCopyCount > 0 ? requestedCopyCount : 1,
        printedDocuments: copyCountChanged ? {} : getUnchangedPrintedDocuments(currentRequest, certificateData),
        downloadedPdfs: copyCountChanged ? {} : currentRequest.downloadedPdfs,
        downloadedWordDocuments: copyCountChanged ? {} : getUnchangedDownloadedWordDocuments(currentRequest, certificateData),
      }
    })
  }

  const downloadApprovedCertificate = async (request, document, certificateDataOverride) => {
    try {
      const certificateData = certificateDataOverride || getCurrentCertificateData(request)
      await downloadFilledCertificateDocx(document, certificateData[document], request.id, customCertificateTemplates)
      setCertificateDownloadError('')
      updateStoredRequest(request.id, (currentRequest) => ({
        ...currentRequest,
        certificateData,
        downloadedWordDocuments: { ...currentRequest.downloadedWordDocuments, [document]: true },
      }))
      return true
    } catch (error) {
      console.error(`Unable to generate the ${document} DOCX.`, error)
      setCertificateDownloadError(`The ${document} DOCX could not be generated. Try again or check the browser console for details.`)
      return false
    }
  }

  const createCertificatePdf = async (request, document) => {
    const docx = await createFilledCertificateDocx(document, getSubmittedCertificateData(request, document), customCertificateTemplates)
    const formData = new FormData()
    const safeRequestId = String(request.id).replace(/[^a-z0-9-]+/gi, '-')
    const safeDocumentName = document.replace(/[^a-z0-9-]+/gi, '-')
    formData.append('certificate', docx, `${safeRequestId}-${safeDocumentName}.docx`)

    const response = await fetch(CERTIFICATE_PDF_URL, {
      method: 'POST',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${officialBackendToken}` },
      body: formData,
    })
    if (!response.ok) {
      const responseBody = await response.text()
      let errorMessage
      try {
        errorMessage = JSON.parse(responseBody).message || responseBody
      } catch {
        errorMessage = responseBody
      }
      throw new Error(errorMessage || `PDF conversion failed with status ${response.status}.`)
    }

    const convertedPdf = await response.blob()
    if (convertedPdf.type !== 'application/pdf') throw new Error('The PDF conversion endpoint returned an invalid file.')
    const copyCount = Number(request.copyCount ?? 1)
    if (!Number.isSafeInteger(copyCount) || copyCount < 1) {
      throw new Error('The requested copy count is invalid.')
    }
    const sourcePdf = await PDFDocument.load(await convertedPdf.arrayBuffer())
    const sourcePageIndices = sourcePdf.getPageIndices()
    if (!sourcePageIndices.length) throw new Error('The converted PDF does not contain any pages.')
    let outputPdf = sourcePdf
    if (copyCount > 1) {
      outputPdf = await PDFDocument.create()
      for (let copyIndex = 0; copyIndex < copyCount; copyIndex += 1) {
        const copiedPages = await outputPdf.copyPages(sourcePdf, sourcePageIndices)
        copiedPages.forEach((page) => outputPdf.addPage(page))
      }
    }

    return new Blob([await outputPdf.save()], { type: 'application/pdf' })
  }

  const downloadApprovedCertificatePdf = async (request, document) => {
    try {
      const downloadPdf = await createCertificatePdf(request, document)
      const copyCount = Number(request.copyCount ?? 1)
      const safeRequestId = String(request.id).replace(/[^a-z0-9-]+/gi, '-')
      const safeDocumentName = document.replace(/[^a-z0-9-]+/gi, '-')
      const objectUrl = URL.createObjectURL(downloadPdf)
      const link = window.document.createElement('a')
      link.href = objectUrl
      link.download = `${safeRequestId}-${safeDocumentName}${copyCount > 1 ? `-${copyCount}-copies` : ''}.pdf`
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
      setCertificateDownloadError('')
      updateStoredRequest(request.id, (currentRequest) => ({
        ...currentRequest,
        downloadedPdfs: { ...currentRequest.downloadedPdfs, [document]: true },
      }))
      return true
    } catch (error) {
      console.error(`Unable to generate the ${document} PDF.`, error)
      setCertificateDownloadError(`The ${document} PDF could not be generated. ${error.message}`)
      return false
    }
  }

  const printApprovedCertificatePdf = async (request, document) => {
    const printWindow = window.open('about:blank', '_blank')
    if (!printWindow) throw new Error('Allow pop-ups to open the certificate PDF for printing.')
    let objectUrl = ''
    try {
      const pdf = await createCertificatePdf(request, document)
      objectUrl = URL.createObjectURL(pdf)
      let printTriggered = false
      const startPrint = () => {
        if (printTriggered || printWindow.closed) return
        printTriggered = true
        printWindow.focus()
        try {
          printWindow.print()
        } catch (printError) {
          console.error(`Unable to open the ${document} print dialog.`, printError)
        }
      }
      printWindow.addEventListener('load', () => window.setTimeout(startPrint, 300), { once: true })
      printWindow.location.replace(objectUrl)
      window.setTimeout(startPrint, 1500)
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 300000)
      setCertificateDownloadError('')
    } catch (error) {
      printWindow.close()
      setCertificateDownloadError(`The ${document} PDF could not be prepared for printing. ${error.message}`)
      throw error
    }
  }

  const startDeclineRequest = () => {
    setShowReturnEditsForm(false)
    setShowDeclineForm(true)
    setDeclineReason('')
    setInvalidRequirements([])
  }
  const startReturnRequestForEdits = (request) => {
    setShowDeclineForm(false)
    setShowReturnEditsForm(true)
    setReturnEditsNote('')
    setInvalidRequirements(getCertificateCorrectionFields(request, customCertificateTemplates)
      .filter(({ missing }) => missing)
      .map(({ correctionKey }) => correctionKey))
  }

  const toggleInvalidRequirement = (requirement) => {
    setInvalidRequirements((currentRequirements) => currentRequirements.includes(requirement)
      ? currentRequirements.filter((currentRequirement) => currentRequirement !== requirement)
      : [...currentRequirements, requirement])
  }

  const declineRequest = (event, requestId) => {
    event.preventDefault()
    const reason = declineReason.trim()
    const invalidList = invalidRequirements.join(', ')
    const declinedAction = `Request declined: ${reason}. Invalid requirements: ${invalidList}`
    const changedAt = new Date()
    setResidentRequests((requests) => requests.map((request) => request.id === requestId
      ? { ...request, status: 'Declined', statusHistory: request.status === 'Declined' ? request.statusHistory || [] : [...(request.statusHistory || []), { status: 'Declined', changedAt: changedAt.toISOString() }], declineReason: reason, invalidRequirements: [...invalidRequirements], activity: [...(request.activity || []), { action: declinedAction, by: 'Barangay Official', time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) }] }
      : request))
    setShowDeclineForm(false)
    setDeclineReason('')
    setInvalidRequirements([])
  }

  const returnRequestForEdits = (event, requestId) => {
    event.preventDefault()
    const note = returnEditsNote.trim()
    if (!note) return
    const changedAt = new Date()
    setResidentRequests((requests) => requests.map((request) => request.id === requestId
      ? {
        ...request,
        status: 'Returned for edits',
        editRequestNote: note,
        invalidRequirements: [...invalidRequirements],
        statusHistory: request.status === 'Returned for edits'
          ? request.statusHistory || []
          : [...(request.statusHistory || []), { status: 'Returned for edits', changedAt: changedAt.toISOString() }],
        activity: [...(request.activity || []), {
          action: `Edits requested: ${note}`,
          by: 'Barangay Official',
          time: changedAt.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        }],
      }
      : request))
    setShowReturnEditsForm(false)
    setReturnEditsNote('')
    setInvalidRequirements([])
  }

  const getOfficialAvailabilityId = (index) => index === 0 ? 'captain' : index === 5 ? 'secretary' : `official-${index}`

  const getOfficialScheduleDetails = (index) => {
    const schedule = officialAvailability.find((entry) => entry.id === getOfficialAvailabilityId(index))
    const days = weekDaysMondayFirst
      .filter(({ day }) => schedule?.days?.includes(day))
      .map(({ label }) => label)
      .join(', ')
    const hours = typeof schedule?.hours === 'string' && schedule.hours !== 'Schedule not set'
      ? schedule.hours.trim()
      : ''
    return { schedule, days, hours }
  }

  const getOfficialAvailabilityStatus = (index) => {
    const { schedule } = getOfficialScheduleDetails(index)
    if (!schedule) return { label: 'Schedule not set', isAvailable: null }

    const hasTodayOverride = schedule.todayOverrideDate === todayDateInput && typeof schedule.isOpenToday === 'boolean'
    if (hasTodayOverride) {
      return { label: schedule.isOpenToday ? 'Available today' : 'Not available today', isAvailable: schedule.isOpenToday }
    }

    if (!Array.isArray(schedule.days) || schedule.days.length === 0) {
      return { label: 'Schedule not set', isAvailable: null }
    }

    const isAvailable = schedule.days.includes(todayDate.getDay())
    return { label: isAvailable ? 'Available today' : 'Not available today', isAvailable }
  }

  const toggleAvailabilityDay = (officialId, day) => {
    setOfficialAvailability((currentAvailability) => {
      const currentOfficial = currentAvailability.find((official) => official.id === officialId)
      const days = currentOfficial?.days || []
      const nextOfficial = currentOfficial
        ? { ...currentOfficial, days: days.includes(day) ? days.filter((availableDay) => availableDay !== day) : [...days, day].sort() }
        : { id: officialId, name: '', role: '', days: [day], hours: 'Schedule not set' }
      return currentOfficial
        ? currentAvailability.map((official) => official.id === officialId ? nextOfficial : official)
        : [...currentAvailability, nextOfficial]
    })
  }

  const updateAvailabilityHours = (officialId, index, hours) => {
    setOfficialAvailability((currentAvailability) => {
      const currentOfficial = currentAvailability.find((official) => official.id === officialId)
      const nextOfficial = currentOfficial
        ? { ...currentOfficial, hours }
        : {
          id: officialId,
          name: officialProfiles[index]?.name || '',
          role: officialProfiles[index]?.role || '',
          days: [],
          hours,
        }
      return currentOfficial
        ? currentAvailability.map((official) => official.id === officialId ? nextOfficial : official)
        : [...currentAvailability, nextOfficial]
    })
  }

  const setOfficeOpenForToday = (isOpen) => {
    const today = getLocalDateInputValue()
    setOfficialAvailability((currentAvailability) => {
      const currentOffice = currentAvailability.find((official) => official.id === 'secretary')
      const nextOffice = currentOffice
        ? { ...currentOffice, todayOverrideDate: today, isOpenToday: isOpen }
        : {
          id: 'secretary',
          name: officialProfiles[5]?.name || '',
          role: officialProfiles[5]?.role || 'Barangay Secretary',
          days: [],
          hours: 'Schedule not set',
          todayOverrideDate: today,
          isOpenToday: isOpen,
        }
      return currentOffice
        ? currentAvailability.map((official) => official.id === 'secretary' ? nextOffice : official)
        : [...currentAvailability, nextOffice]
    })
  }

  const restoreOfficeWeeklySchedule = () => {
    setOfficialAvailability((currentAvailability) => currentAvailability.map((official) => (
      official.id === 'secretary'
        ? { ...official, todayOverrideDate: '', isOpenToday: null }
        : official
    )))
  }

  const updateCommunityUpdateField = (field, value) => {
    setCommunityUpdateForm((currentForm) => ({ ...currentForm, [field]: value }))
    if (field === 'startTime' || field === 'endTime') setCommunityUpdateTimeError('')
  }

  const uploadCommunityUpdateImage = async (file) => {
    setCommunityUpdateImageError('')
    if (!file) return
    try {
      setCommunityUpdateImage(await createCommunityUpdateImage(file))
    } catch (error) {
      console.error('Unable to prepare a community update image.', error)
      setCommunityUpdateImageError(`${file.name}: ${error.message}`)
      if (communityUpdateImageInputRef.current) communityUpdateImageInputRef.current.value = ''
    }
  }

  const resetCommunityUpdateForm = () => {
    setCommunityUpdateForm({ type: 'announcement', title: '', location: '', startTime: '', endTime: '', description: '', date: '' })
    setCommunityUpdateFormOpen(false)
    setCommunityUpdateTimeError('')
    setCommunityUpdateImage(null)
    setCommunityUpdateImageError('')
    if (communityUpdateImageInputRef.current) communityUpdateImageInputRef.current.value = ''
    setEditingUpdateId(null)
  }

  const saveCommunityUpdate = (event) => {
    event.preventDefault()
    if (Boolean(communityUpdateForm.startTime) !== Boolean(communityUpdateForm.endTime)) {
      setCommunityUpdateTimeError('Enter both a start time and an end time, or leave both blank.')
      return
    }
    const update = {
      ...communityUpdateForm,
      title: communityUpdateForm.title.trim(),
      location: communityUpdateForm.location.trim(),
      description: communityUpdateForm.description.trim(),
      time: '',
      image: communityUpdateImage,
    }
    const savedUpdate = editingUpdateId
      ? { ...update, id: editingUpdateId }
      : { ...update, id: `community-update-${Date.now()}` }
    const nextUpdates = editingUpdateId
      ? communityUpdates.map((currentUpdate) => currentUpdate.id === editingUpdateId ? savedUpdate : currentUpdate)
      : [...communityUpdates, savedUpdate]
    if (persistCommunityUpdates(nextUpdates.sort((first, second) => first.date.localeCompare(second.date)))) {
      resetCommunityUpdateForm()
    }
  }

  const editCommunityUpdate = (update) => {
    setCommunityUpdateForm({
      type: update.type,
      title: update.title,
      location: update.location || '',
      startTime: update.startTime || update.time || '',
      endTime: update.endTime || '',
      description: update.description || update.detail || '',
      date: update.date,
    })
    setCommunityUpdateImage(update.image || null)
    setCommunityUpdateImageError('')
    setEditingUpdateId(update.id)
    setCommunityUpdateFormOpen(true)
  }

  const deleteCommunityUpdate = (update) => {
    if (!window.confirm(`Delete "${update.title}"? Residents will no longer see it.`)) return
    persistCommunityUpdates(communityUpdates.filter((currentUpdate) => currentUpdate.id !== update.id))
    if (editingUpdateId === update.id) resetCommunityUpdateForm()
  }

  const isHomePage = !showOfficials && !showAboutPage && !showResidentCheck && !showResidentOptions && !showRegistrationForm && !showResidentInboxPage && !showRequestForm && !showReview && !showOfficialLogin && !showOfficialDashboard && !requestSubmitted
  const startSystem = () => {
    setHasStarted(true)
    welcomePageRef.current?.scrollTo({ top: 0, behavior: 'auto' })
  }
  const recoveryDeliveryDetails = recoveryDeliveryRequest
    ? getRecoveryResidentDetails(recoveryDeliveryRequest)
    : null
  return (
    <main ref={welcomePageRef} className={`welcome-page ${isHomePage ? 'is-home-page' : ''} ${isHomePage && !hasStarted ? 'is-startup-page' : ''} ${showAboutPage ? 'is-about-page' : ''} ${showOfficialLogin ? 'is-official-login-page' : ''} ${showOfficialLogin || showResidentOptions || showRegistrationForm || (showResidentCheck && !inboxAccessMode && !showRequestForm && !showReview && !showDocumentOptions) ? 'is-access-page' : ''} ${showResidentOptions ? 'is-resident-choice-page' : ''} ${showOfficials ? 'is-officials-page' : ''} ${showResidentCheck || showResidentOptions || showRegistrationForm || showResidentInboxPage ? 'is-resident-page' : ''} ${showRequestForm || showReview ? 'is-request-workflow-page' : ''} ${showRegistrationForm ? 'is-registration-page' : ''} ${showOfficialDashboard ? 'is-dashboard-page' : ''}`} style={{ '--background-image': `url(${barangayHall})` }}>
      {hasStarted && !showResidentCheck && !showResidentOptions && !showRegistrationForm && !showResidentInboxPage && !showOfficialDashboard && (
        <header className="topbar">
          <img className="brand-mark" src={barangaySeal} alt="Barangay Bagong Bayan 1 seal" />
          <div className="brand-copy">
            <span className="eyebrow">Barangay Bagong Bayan 1</span>
            <strong>BARANGAY RECORD MANAGEMENT</strong>
          </div>
          <span className="topbar-note"><i aria-hidden="true" /> LOCAL SERVICES · COMMUNITY UPDATES</span>
        </header>
      )}

      {showAboutPage ? (
        <section className="about-page" aria-labelledby="about-history-heading">
          <div className="about-page-toolbar">
            <button type="button" className="about-page-back" onClick={closeAboutPage}>
              <span aria-hidden="true">←</span> {aboutFromResidentDashboard ? 'Close' : aboutFromDashboard ? 'Back to dashboard' : 'Back to access portal'}
            </button>
            <span>BARANGAY BAGONG BAYAN-I</span>
          </div>
          <div className="about-history-content">
            <div className="about-page-heading">
              <div className="about-page-hero-copy">
                <span className="about-page-hero-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24"><path d="M12 21v-8M5 10.5a7 7 0 0 1 14 0c0 3.9-3.1 6.5-7 6.5s-7-2.6-7-6.5Z" /><path d="M8.5 10.5h7M12 3.5v13.5" /></svg>
                </span>
                <div>
                  <p className="section-number">COMMUNITY HERITAGE · TEXT VERSION</p>
                  <h1 id="about-history-heading">Kasaysayan ng<br /><em>Bagong Bayan-I</em></h1>
                  <p className="intro-copy">Kilalanin ang pinagmulan, mga lugar, at mahahalagang pangyayari sa kasaysayan ng ating barangay.</p>
                </div>
              </div>
              <nav className="about-history-highlights" aria-label="Mga pangunahing datos">
                <a href="#area-details"><strong>68.0140</strong><span>ektarya</span><small>Kabuuang lawak</small></a>
                <a href="#zone-history"><strong>21</strong><span>blocks</span><small>Sa pitong sona</small></a>
                <a href="#zone-history"><strong>22</strong><span>streets</span><small>Mga kalsada</small></a>
                <a href="#zone-history"><strong>7</strong><span>sona</span><small>Para sa bawat kagawad</small></a>
              </nav>
            </div>

            <div className="about-history-intro-grid">
              <section className="about-history-section about-history-background-section" id="poblacion-history">
                <div className="about-history-section-heading">
                  <AboutHistoryIcon type="timeline" />
                  <div><p className="section-number">MGA PINAGMULAN</p><h2>Historical Background of Poblacion into Five Barangay</h2></div>
                  <span className="about-history-card-index">01</span>
                </div>
                <div className="about-history-background-layout">
                  <div>
                    <p className="about-origin-paragraph">{poblacionOrigin}</p>
                    <ol className="about-history-timeline">
                      {poblacionHistory.map((event, index) => (
                        <li key={`${event.year || 'origin'}-${index}`}>
                          <strong className="about-history-year">{event.year}</strong>
                          <p>{event.text}</p>
                        </li>
                      ))}
                    </ol>
                  </div>
                  <figure className="about-history-figure about-history-history-photo">
                    <img src={barangayHistoryPhotos[0].src} alt={barangayHistoryPhotos[0].alt} loading="lazy" />
                    <figcaption>{barangayHistoryPhotos[0].caption}</figcaption>
                  </figure>
                </div>
              </section>

              <div className="about-history-side-stack about-history-below-history">
                <section className="about-history-section">
                  <div className="about-history-section-heading">
                    <AboutHistoryIcon type="community" />
                    <div><p className="section-number">MAIKLING KASAYSAYAN</p><h2>Maikling Kasaysayan ng Bagong Bayan <span>(buod)</span></h2></div>
                    <span className="about-history-card-index">02</span>
                  </div>
                  <p>Ang Bagong Bayan ay dating bahagi ng “Parang,” isang sityo ng Poblacion. Kapag tinatanong noon ang mga taga-roon kung saan sila nakatira, ang sagot ay “sa Parang.” Para luminaw, tinatanong pa kung saang bahagi ng Parang: FACOMA (ngayon ay Bagong Bayan-II) o BUKAL (ngayon ay Bagong Bayan-I).</p>
                </section>

                <section className="about-history-contact-panel" aria-labelledby="barangay-contact-title">
                  <div className="about-history-contact-heading">
                    <AboutHistoryIcon type="contact" />
                    <div><p className="section-number">BARANGAY DETAILS</p><h2 id="barangay-contact-title">Contact Information</h2></div>
                  </div>
                  <div className="about-history-contact-fields">
                    <label htmlFor="barangay-contact-phone">Phone number<input id="barangay-contact-phone" type="tel" value={(barangayContactInformationDraft ?? barangayContactInformation).phoneNumber} onChange={(event) => {
                      setBarangayContactInformationDraft({ ...(barangayContactInformationDraft ?? barangayContactInformation), phoneNumber: event.target.value })
                      setBarangayContactInformationError('')
                      setBarangayContactInformationStatus('')
                    }} /></label>
                    <label htmlFor="barangay-contact-email">Email address<input id="barangay-contact-email" type="email" value={(barangayContactInformationDraft ?? barangayContactInformation).emailAddress} onChange={(event) => {
                      setBarangayContactInformationDraft({ ...(barangayContactInformationDraft ?? barangayContactInformation), emailAddress: event.target.value })
                      setBarangayContactInformationError('')
                      setBarangayContactInformationStatus('')
                    }} /></label>
                    <label className="about-history-contact-address" htmlFor="barangay-contact-address">Office address<input id="barangay-contact-address" type="text" value={(barangayContactInformationDraft ?? barangayContactInformation).officeAddress} onChange={(event) => {
                      setBarangayContactInformationDraft({ ...(barangayContactInformationDraft ?? barangayContactInformation), officeAddress: event.target.value })
                      setBarangayContactInformationError('')
                      setBarangayContactInformationStatus('')
                    }} /></label>
                  </div>
                  {barangayContactInformationError && <p className="about-history-contact-error" role="alert">{barangayContactInformationError}</p>}
                  <div className="about-history-contact-actions">
                    <p role="status" aria-live="polite">{barangayContactInformationStatus}</p>
                    <div>
                      {barangayContactInformationDraft !== null && <button type="button" className="about-history-contact-cancel" onClick={() => {
                        setBarangayContactInformationDraft(null)
                        setBarangayContactInformationError('')
                        setBarangayContactInformationStatus('')
                      }}>Cancel</button>}
                      <button type="button" className="about-history-contact-save" disabled={barangayContactInformationDraft === null || ['phoneNumber', 'emailAddress', 'officeAddress'].every((field) => barangayContactInformationDraft[field] === barangayContactInformation[field])} onClick={saveBarangayContactInformation}>Save</button>
                    </div>
                  </div>
                </section>
              </div>
            </div>

            <section className="about-history-section about-history-zone-section about-history-zone-guide-section">
              <div>
                <div className="about-history-section-heading">
                  <AboutHistoryIcon type="zones" />
                  <div><p className="section-number">MGA SONA</p><h2>Mga Sona <span>(buod)</span></h2></div>
                  <span className="about-history-card-index">03</span>
                </div>
                <div id="zone-history" className="about-history-anchor" />
                <ul>
                  {zoneHistory.map((fact) => <li key={fact}>{fact}</li>)}
                  <li>Sa litrato: “Zone I, II, III, IV, V, VI &amp; VII.”</li>
                </ul>
              </div>
              <CommunityMapGuide />
            </section>

            <section className="about-history-section about-history-overview">
              <div className="about-history-section-heading">
                <AboutHistoryIcon type="area" />
                <div><p className="section-number">ANG BAGONG BAYAN-I</p><h2>Ang Bagong Bayan-I <span>(buod)</span></h2></div>
                <span className="about-history-card-index">04</span>
              </div>
              <ul>
                <li>Panahon ni Mayor Jose “Ute” Enriquez: ang mga kalye ay pangalan ng mga bulaklak. Nang maluklok si Mayor Renato “Kato” Reyes, pinalitan ito ng mga pangalan ng bayani at magigiting na tao sa Bongabong noong World War II.</li>
                <li>Pista: Ang Pistang Bayan ay tuwing Marso 17–19, nakasentro sa Poblacion. Pagsapit ng Mayo, may kanya-kanyang Santakrusan o Flores De Mayo ang bawat barangay. Ang Bagong Bayan-I ay may sariling pista tuwing Abril 23 at 24.</li>
                <li>Kabuuang lawak: 68.0140 ektarya, na may dalawang uri ng paglalarawan (topograpiya).</li>
              </ul>
              <div className="about-history-area-grid" id="area-details">
                <article>
                  <h3>1. Mababang Lugar <span>(Low-Lying / Agricultural)</span></h3>
                  <ul>{lowLyingAreaFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                </article>
                <article>
                  <h3>2. Mataas na Lugar <span>(Elevated / Residential &amp; Commercial)</span></h3>
                  <ul>{elevatedAreaFacts.map((fact) => <li key={fact}>{fact}</li>)}</ul>
                </article>
              </div>
            </section>

            <section className="about-history-section about-history-election-section">
              <div>
                <div className="about-history-section-heading">
                  <AboutHistoryIcon type="election" />
                  <div><p className="section-number">1986</p><h2>Unang Barangay Election</h2></div>
                  <span className="about-history-card-index">05</span>
                </div>
                <div id="first-election" className="about-history-anchor" />
                <p>Ito ang unang pagkakataong naghalal ng bagong pamunuan ang 5 barangay na nahati noong 1983. Ang mga kandidato sa Bagong Bayan-I:</p>
                <ul>{firstBarangayOfficials.map((official) => <li key={official}>{official}</li>)}</ul>
              </div>
              <figure className="about-history-figure about-history-council">
                <img src={barangayHistoryPhotos[3].src} alt={barangayHistoryPhotos[3].alt} loading="lazy" />
                <figcaption>{barangayHistoryPhotos[3].caption}</figcaption>
              </figure>
            </section>

            <section className="about-history-section">
              <div className="about-history-section-heading">
                <AboutHistoryIcon type="edsa" />
                <div><p className="section-number">1986 · EDSA</p><h2>Presidential Election at EDSA <span>(buod)</span></h2></div>
                <span className="about-history-card-index">06</span>
              </div>
              <div id="edsa-1986" className="about-history-anchor" />
              <p>Nagkaroon ng Presidential Election, Cory Aquino laban kay President Marcos. Hindi matanggap ng taong bayan ang pagkatalo ni Cory dahil sa matinding dayaan, kaya nagkaroon ng pag-aaklas noong Pebrero 25, 1986 (People Power EDSA Revolution). Iniluklok si Pangulong Cory Aquino sa ilalim ng Revolutionary Form of Government. Nawalan ng bisa at karapatan ang mga halal na opisyal ng barangay at di nagtagal ay nagtalaga ng mga Kapitan hanggang Konsehal bilang Officer-In-Charge (OIC):</p>
              <ul>{edsaOicOfficials.map((official) => <li key={official}>{official}</li>)}</ul>
            </section>

            <section className="about-history-gallery">
              <div>
                <p className="section-number">MGA LARAWAN</p>
                <h2>Mga dokumento ng barangay</h2>
              </div>
              <figure className="about-history-figure about-history-records">
                <img src={barangayHistoryPhotos[4].src} alt={barangayHistoryPhotos[4].alt} loading="lazy" />
                <figcaption>{barangayHistoryPhotos[4].caption}</figcaption>
              </figure>
            </section>
          </div>
        </section>
      ) : showOfficials ? (
        <section className="officials-page">
          <div className="officials-heading">
            <p className="section-number">COMMUNITY LEADERSHIP</p>
            <h1>Barangay<br /><em>officials.</em></h1>
            <p className="intro-copy">Meet the people entrusted to serve Barangay Bagong Bayan 1.</p>
          </div>
          <div className="officials-list">
            {officialProfiles.map((official, index) => {
              const availability = getOfficialAvailabilityStatus(index)
              const enteredName = official.name?.trim()
              const name = enteredName && !/^name to be updated$/i.test(enteredName) ? enteredName : 'Official name not set'
              return (
              <div className="official-row" key={`${official.role}-${index}`}>
                <span className="official-number">0{index + 1}</span>
                <strong>{name}</strong>
                <span className="official-role">{official.role || 'Barangay Official'}</span>
                <span className={`official-availability-status${availability.isAvailable === true ? ' is-available' : availability.isAvailable === false ? ' is-unavailable' : ' is-not-set'}`}>{availability.label}</span>
              </div>
              )
            })}
          </div>
        </section>
      ) : showOfficialDashboard && adminView === 'certificateProcessing' ? (
        <section className={`certificate-processing-screen ${darkMode ? 'dark-mode' : ''} font-${fontSize}`}>
          <header className="certificate-processing-screen-header">
            <div className="admin-brand"><img src={barangaySeal} alt="" /><span><strong>Barangay Bagong Bayan 1</strong><small>Certificate processing</small></span></div>
            <div className="certificate-processing-screen-actions">
              <button
                type="button"
                className="open-request"
                onClick={() => {
                  markAdminNavigationSectionRead('documents')
                  setAdminView('documents')
                  const targetRequest = allDocumentRequests.find((request) => request.id === certificateProcessingRequestId)
                  const isReadyForRelease = targetRequest?.status === 'Ready for release'
                  setDocumentQueueFilter(isReadyForRelease ? 'release' : 'processing')
                  setSelectedRequestId(isReadyForRelease ? null : certificateProcessingRequestId)
                  setCertificateProcessingRequestId(null)
                  setCertificateProcessingRequestGroupIds([])
                  setCertificateProcessingDocument(null)
                }}
              >
                Back to requests
              </button>
              {certificateProcessingRequest?.status === 'Approved - scheduling'
                && !certificateProcessingRequest.printCompletedAt
                && !certificateProcessingRequest.documents.some((document) => certificateProcessingRequest.printedDocuments?.[document])
                && <button type="button" className="open-request" onClick={() => recordAction(certificateProcessingRequest.id, 'Reopened for review')}>Return to review</button>}
              <button type="button" className="dashboard-logout" onClick={logoutOfficial}>Log out</button>
            </div>
          </header>
          <div className="certificate-processing-screen-content">
            <div className="certificate-processing-heading">
              <span className="certificate-processing-heading-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M7 3.5h7l4 4v13H7zM14 3.5v4h4M10 12h5M10 15h5" /></svg>
              </span>
              <div className="certificate-processing-heading-copy">
                <p className="section-number">CERTIFICATE PRODUCTION</p>
                <h2>{certificateProcessingRequest?.resident || 'Request unavailable'}</h2>
                {certificateProcessingRequest && <div className="certificate-processing-meta">
                  <span className="certificate-request-code">{certificateProcessingRequest.id}</span>
                  {certificateProcessingRequest.documents.map((document) => <span className="certificate-request-document-tag" key={document}>{document}</span>)}
                </div>}
              </div>
              {certificateProcessingRequest && <span className="certificate-processing-approved-badge"><span aria-hidden="true">✓</span> Approved</span>}
            </div>
            {certificateProcessingRequest && (() => {
              const preparedDocumentCount = certificateProcessingRequest.documents.filter((document) => certificateProcessingRequest.printedDocuments?.[document]).length
              const allDocumentsPrepared = certificateProcessingRequest.status === 'Ready for release' && Boolean(certificateProcessingRequest.printCompletedAt)
              const progressPercent = certificateProcessingRequest.documents.length
                ? Math.round((preparedDocumentCount / certificateProcessingRequest.documents.length) * 100)
                : 0
              return <div className="certificate-release-next-step">
                <div className="certificate-progress-content">
                  <div className="certificate-progress-heading">
                    <span className="certificate-progress-icon" aria-hidden="true">{allDocumentsPrepared ? '✓' : '01'}</span>
                    <div><p className="section-number">PREPARATION PROGRESS</p><strong>{allDocumentsPrepared ? 'Documents are ready' : `${preparedDocumentCount} of ${certificateProcessingRequest.documents.length} documents ready`}</strong></div>
                  </div>
                  <div className="certificate-progress-track" role="progressbar" aria-label="Certificate preparation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progressPercent}>
                    <span style={{ width: `${progressPercent}%` }} />
                  </div>
                  <p className="certificate-progress-hint">{allDocumentsPrepared ? 'Continue to set pickup details and notify the resident.' : 'Choose an output format, confirm the number of copies, then download or print.'}</p>
                </div>
                <button type="button" className="certificate-release-button" disabled={!allDocumentsPrepared} onClick={() => {
                          const request = certificateProcessingRequest
                            markAdminNavigationSectionRead('documents')
                          setAdminView('documents')
                          setDocumentQueueFilter('release')
                          setSelectedRequestId(request.id)
                          startReadyForRelease(request)
                          setCertificateProcessingRequestId(null)
                          setCertificateProcessingRequestGroupIds([])
                          setCertificateProcessingDocument(null)
                        }}><span>Set release details</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></button>
              </div>
            })()}
            {certificateProcessingRequest?.status === 'Ready for release' && certificateProcessingRequest.printCompletedAt ? (
              <section className="certificate-processing-complete" role="status">
                <span className="certificate-processing-complete-icon" aria-hidden="true">✓</span>
                <p className="section-number">DOCUMENTS PREPARED</p>
                <h3>Ready to set release details</h3>
                <p>All requested documents for {certificateProcessingRequest.resident} have been downloaded and prepared. Set the pickup details and notify the resident when you are ready.</p>
              </section>
            ) : certificateProcessingRequest ? (
              <div className="certificate-processing-body">
                <ApprovedCertificateEditor
                  key={certificateProcessingRequest.id}
                  request={certificateProcessingRequest}
                  certificateDownloadError={certificateDownloadError}
                  getCurrentCertificateData={getCurrentCertificateData}
                  saveCertificateReview={saveCertificateReview}
                  downloadApprovedCertificate={downloadApprovedCertificate}
                  downloadApprovedCertificatePdf={downloadApprovedCertificatePdf}
                  printApprovedCertificatePdf={printApprovedCertificatePdf}
                  recordPrintedDocument={(request, document, certificateData) => {
                    const sourceRequests = (request.processingRequestIds || [request.id])
                      .map((requestId) => allDocumentRequests.find((candidate) => candidate.id === requestId))
                      .filter(Boolean)
                    sourceRequests.forEach((sourceRequest) => {
                      recordPrintedDocument(sourceRequest, document, {
                        ...getCurrentCertificateData(sourceRequest),
                        [document]: certificateData[document],
                      })
                    })
                  }}
                  initialDocument={certificateProcessingDocument}
                  customTemplates={customCertificateTemplates}
                />
              </div>
            ) : (
              <p className="request-search-empty">This certificate request is no longer available. Return to the request list.</p>
            )}
          </div>
        </section>
      ) : showOfficialDashboard ? (
        <section className={`official-dashboard ${darkMode ? 'dark-mode' : ''} dashboard-redesign font-${fontSize}`}>
          <header className="admin-header">
            <button type="button" className="admin-menu-toggle" aria-label={sidebarOpen ? 'Hide navigation' : 'Show navigation'} aria-expanded={sidebarOpen} aria-controls="admin-sidebar-navigation" onClick={() => setSidebarOpen((open) => !open)}>☰</button>
            <div className="admin-brand"><img src={barangaySeal} alt="" /><span><strong>Barangay Bagong Bayan 1</strong><small>Records management</small></span></div>
            <div className="admin-header-actions">
              <button type="button" className="admin-icon-button about-icon-button" aria-label="About Barangay Bagong Bayan I" title="About" onClick={openAboutPage}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" /></svg><span className="about-icon-label" aria-hidden="true">About</span>
              </button>
              <div className="header-menu-wrap">
                <button type="button" className="admin-icon-button notification-button" aria-label={`Notifications (${notificationCount})`} aria-expanded={notificationsOpen} onClick={() => { setNotificationsOpen((open) => !open); setProfileOpen(false) }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>{notificationCount > 0 && <span className="notification-dot">{notificationCount}</span>}</button>
                {notificationsOpen && <div className="admin-popover notification-popover">
                  <strong>Notifications</strong>
                  {documentProcessingRequests.filter((request) => request.status === 'New' && isAdminNotificationUnread('documents', 'document', request)).map((request) => <button type="button" key={request.id} onClick={() => { markAdminNotificationRead('documents', 'document', request); setAdminView('documents'); setSelectedRequestId(request.id); setNotificationsOpen(false) }}><span>New document request</span><small>{getRequestResidentName(request)} · {request.id}</small></button>)}
                  {documentInboxRequests.filter((request) => request.status === 'For Verification' && isAdminNotificationUnread('documents', 'document', request)).map((request) => {
                    const latestActivity = request.activity?.slice(-1)[0]
                    const wasCorrectedAndResubmitted = /^Corrected requirements resubmitted for review/i.test(latestActivity?.action || '')
                    return <button type="button" key={`verification-${request.id}`} onClick={() => { markAdminNotificationRead('documents', 'document', request); setAdminView('documents'); setSelectedRequestId(request.id); setNotificationsOpen(false) }}>
                      <span>{wasCorrectedAndResubmitted ? 'Corrected request resubmitted' : 'Request awaiting verification'}</span>
                      <small>{getRequestResidentName(request)} · {request.id}</small>
                    </button>
                  })}
                  {pendingRegistrationRequests.filter((request) => isAdminNotificationUnread('registrations', 'registration', request)).map((request) => <button type="button" key={request.id} onClick={() => { markAdminNotificationRead('registrations', 'registration', request); setAdminView('registrations'); setNotificationsOpen(false) }}><span>Resident registration</span><small>{request.name} · {request.id}</small></button>)}
                  {residentCodeRecoveryRequests.filter((request) => request.status === 'Pending' && isAdminNotificationUnread('residents', 'recovery', request)).map((request) => <button type="button" key={request.id} onClick={() => { markAdminNotificationRead('residents', 'recovery', request); const closestResident = getClosestResidentRecord(request.fullName, adminResidents); setAdminView('residents'); setResidentRecordsTab('active'); setResidentRecordsSearch(closestResident?.name || request.fullName); setHighlightedResidentId(closestResident?.id || ''); setAdminRecoveryMessage(''); setNotificationsOpen(false) }}><span>Resident code recovery</span><small>{request.fullName} · {request.id}</small></button>)}
                  {residentProfileUpdateRequests.filter((request) => request.status === 'Pending' && isAdminNotificationUnread('residents', 'profile-update', request)).map((request) => <button type="button" key={request.id} onClick={() => { markAdminNotificationRead('residents', 'profile-update', request); setAdminView('residents'); setResidentRecordsTab('active'); setResidentProfileUpdateResidentCode(request.residentCode); setProfileUpdateError(''); setNotificationsOpen(false) }}><span>Profile update request</span><small>{request.resident} · {request.id}</small></button>)}
                  {paymentAssessmentRecords.filter((request) => isAdminNotificationUnread('payments', 'payment', request)).map((request) => <button type="button" key={`payment-${request.id}`} onClick={() => { markAdminNotificationRead('payments', 'payment', request); setAdminView('payments'); setPaymentReviewRequestId(request.id); setNotificationsOpen(false) }}><span>Payment proof to verify</span><small>{request.resident} · {request.documents.join(' · ')}</small></button>)}
                  {cancelledPaymentRequests.filter((request) => (
                    (request.paymentStatus === 'Pending verification' || request.refundStatus !== 'Refunded')
                      && isAdminNotificationUnread('payments', 'refund', request)
                  )).map((request) => <button type="button" key={`refund-${request.id}`} onClick={() => { markAdminNotificationRead('payments', 'refund', request); setAdminView('refunds'); setNotificationsOpen(false) }}><span>Cancellation follow-up</span><small>{request.resident} · {request.id}</small></button>)}
                  {notificationCount === 0 && <p>You're all caught up.</p>}
                </div>}
              </div>
              <div className="header-menu-wrap">
                <button type="button" className="admin-profile-button" aria-label="Admin profile and settings" aria-expanded={profileOpen} onClick={() => { setProfileOpen((open) => !open); setNotificationsOpen(false) }}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5" /><path d="M5.5 20a6.5 6.5 0 0 1 13 0" /></svg>
                  <span aria-hidden="true">⌄</span>
                </button>
                {profileOpen && <div className="admin-popover profile-popover">
                  <div className="profile-popover-heading"><span className="profile-popover-avatar" aria-hidden="true">A</span><span><strong>Administrator</strong><small>Barangay admin</small></span></div>
                  <p className="profile-popover-label">ACCOUNT</p>
                  <button type="button" className="profile-menu-action" onClick={() => { setAdminView('settings'); setProfileOpen(false) }}>
                    <span className="profile-menu-action-icon" aria-hidden="true">⚙</span><span><strong>Settings</strong><small>Display and dashboard preferences</small></span><span className="profile-menu-action-arrow" aria-hidden="true">›</span>
                  </button>
                  <button type="button" className="profile-menu-action" onClick={() => { setAdminView('security'); setProfileOpen(false) }}>
                    <span className="profile-menu-action-icon" aria-hidden="true">◇</span><span><strong>Security &amp; devices</strong><small>Password and session protection</small></span><span className="profile-menu-action-arrow" aria-hidden="true">›</span>
                  </button>
                  <div className="profile-menu-divider" />
                  <button type="button" className="profile-logout" onClick={logoutOfficial}>Log out</button>
                </div>}
              </div>
            </div>
          </header>
          <div className={`admin-layout ${sidebarOpen ? '' : 'sidebar-collapsed'}`}>
            {sidebarOpen && <button type="button" className="admin-sidebar-backdrop" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}
            {sidebarOpen && <aside id="admin-sidebar-navigation" className="admin-sidebar" aria-label="Admin navigation">
              <div className="admin-sidebar-identity">
                <span className="admin-sidebar-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="m3 9 9-5 9 5M5 10v8m4-8v8m6-8v8m4-8v8M3 19h18m-19 2h20" />
                  </svg>
                </span>
                <strong>Barangay Management System</strong>
              </div>
              {[
                { title: 'Dashboard', items: [['overview', 'Overview', '⌂']] },
                { title: 'Community services', items: [['announcements', 'Announcements & events', '▤']] },
                { title: 'Requests', items: [['documents', 'Resident document requests', '▣'], ['registrations', 'Registration requests', '＋'], ['payments', 'Payment tracking', '₱']] },
                { title: 'Resident records', items: [['officials', 'Officials', '♙'], ['residents', 'Resident records', '♧']] },
                { title: 'Documents & reports', items: [['certificateTemplates', 'Certificate templates', '▤'], ['issuedDocuments', 'Issued documents', '▣']] },
              ].map((group) => <section className="admin-nav-group" key={group.title} aria-label={group.title}>
                <p>{group.title}</p>
                {group.items.map(([view, label, icon]) => {
                  const isActive = adminView === view
                    || (view === 'documents' && adminView === 'certificateProcessing')
                    || (view === 'payments' && adminView === 'refunds')
                  const unreadCount = [
                    'overview',
                    'announcements',
                    'documents',
                    'registrations',
                    'payments',
                    'officials',
                    'residents',
                    'certificateTemplates',
                    'issuedDocuments',
                  ].includes(view)
                    ? adminNavigationUnreadCounts[view]
                    : 0
                  return <button type="button" key={view} className={`${isActive ? 'active' : ''}${unreadCount ? ' has-unread-updates' : ''}`} aria-current={isActive ? 'page' : undefined} onClick={() => { if (view !== 'certificateTemplates') setHighlightedCertificateTemplate(null); markAdminViewRead(view); setAdminView(view); if (window.matchMedia('(max-width: 720px)').matches) setSidebarOpen(false) }}><span aria-hidden="true">{icon}</span>{label}{unreadCount > 0 && <span className="resident-request-new-dot" role="img" aria-label="New update" title="New update" />}{unreadCount > 0 && <small className="admin-nav-unread-count" aria-label={`${unreadCount} new items`} title={`${unreadCount} new or updated items`}>{unreadCount}</small>}</button>
                })}
              </section>)}
            </aside>}
            <div className="admin-content" ref={adminContentRef}>
          {!isDatabaseConnected
            ? <div className={`database-save-indicator is-${databaseSaveStatus}`} role="status">
              <span className="database-sync-indicator" aria-hidden="true" />
              <span>{databaseSaveStatus === 'checking'
                ? 'Connecting to shared database…'
                : `Not saved to shared database. ${databaseSaveError || 'Retrying connection automatically.'}`}</span>
            </div>
            : <div className={`database-save-indicator is-${databaseSaveStatus}`} role="status"><span className="database-sync-indicator" aria-hidden="true" /><span>{databaseSaveStatus === 'saving' ? 'Saving changes to shared database…' : databaseSaveStatus === 'error' ? `Database save failed. ${databaseSaveError}` : 'Changes saved to shared database'}</span></div>}
          {adminView === 'overview' && <div className="dashboard-heading admin-overview-heading">
            <h1>Overview</h1>
            <span className="dashboard-date">{new Date().toLocaleDateString('en-US', { dateStyle: 'full' })}</span>
          </div>}
          {adminView === 'overview' && <>
            <div className="overview-stats">
              <article><span>Current residents</span><strong>{adminResidents.length}</strong></article>
              <article><span>Document requests</span><strong>{allDocumentRequests.length}</strong></article>
              <article className="overview-completion-stat">
                <span>Completion rate</span>
                <strong>{dashboardCompletionRate}%</strong>
                <small>{dashboardCompletedRequestCount} of {allDocumentRequests.length} requests</small>
                <div role="meter" aria-label="Document request completion rate" aria-valuemin={0} aria-valuemax={100} aria-valuenow={dashboardCompletionRate}>
                  <span style={{ width: `${dashboardCompletionRate}%` }} />
                </div>
              </article>
              <article className={dashboardNeedsActionIds.size ? 'needs-attention' : ''}><span>Items needing staff action</span><strong>{dashboardNeedsActionIds.size}</strong></article>
            </div>
            <section className="admin-performance-panel admin-monthly-performance-panel" aria-labelledby="admin-monthly-performance-title">
              <header>
                <div><span className="section-number">MONTHLY PERFORMANCE</span><h2 id="admin-monthly-performance-title">Service activity by month</h2><p>Document requests received compared with completed requests over the last six months.</p></div>
                <span className="admin-performance-total">Last 6 months</span>
              </header>
              <div className="admin-monthly-performance-chart">
                <svg viewBox="0 0 740 240" role="img" aria-labelledby="admin-monthly-chart-title admin-monthly-chart-description">
                  <title id="admin-monthly-chart-title">Monthly document requests and completions</title>
                  <desc id="admin-monthly-chart-description">A six-month line graph comparing requests received with completed requests. The values are labeled at each month.</desc>
                  {[0, 1, 2, 3, 4].map((line) => {
                    const y = 24 + line * 38
                    return <line className="admin-monthly-performance-gridline" key={line} x1="40" x2="700" y1={y} y2={y} />
                  })}
                  <polyline className="admin-monthly-performance-line is-request" points={dashboardMonthlyPerformancePoints.map((month) => `${month.x},${month.requestsY}`).join(' ')} />
                  <polyline className="admin-monthly-performance-line is-completed" points={dashboardMonthlyPerformancePoints.map((month) => `${month.x},${month.completedY}`).join(' ')} />
                  {dashboardMonthlyPerformancePoints.map((month) => <g key={month.key}>
                    <circle className="admin-monthly-performance-point is-request" cx={month.x} cy={month.requestsY} r="5" />
                    <circle className="admin-monthly-performance-point is-completed" cx={month.x} cy={month.completedY} r="5" />
                    <text className="admin-monthly-performance-value is-request" x={month.x} y={Math.max(14, month.requestsY - 10)} textAnchor="middle">{month.requests}</text>
                    <text className="admin-monthly-performance-value is-completed" x={month.x} y={Math.min(202, month.completedY + 18)} textAnchor="middle">{month.completed}</text>
                    <text className="admin-monthly-performance-month-label" x={month.x} y="226" textAnchor="middle">{month.label}</text>
                  </g>)}
                </svg>
              </div>
              <div className="admin-monthly-performance-legend" aria-label="Chart legend">
                <span className="is-request">Requests</span><span className="is-completed">Completed</span>
              </div>
            </section>
            <section className="admin-performance-panel" aria-labelledby="admin-performance-title">
              <header>
                <div><span className="section-number">SERVICE WORKFLOW</span><h2 id="admin-performance-title">Request performance</h2><p>Current request counts and percentage of all document requests by status.</p></div>
                <span className="admin-performance-total">{allDocumentRequests.length} total</span>
              </header>
              <div className="admin-performance-chart" role="list" aria-label="Document request counts by status">
                {dashboardPerformanceStagesWithShare.map((stage) => <div className="admin-performance-stage" role="listitem" key={stage.label}>
                  <div className="admin-performance-value"><strong>{stage.count}</strong><small>{stage.share}%</small></div>
                  <div className="admin-performance-track" role="meter" aria-label={`${stage.label} requests`} aria-valuemin={0} aria-valuemax={dashboardPerformanceMax} aria-valuenow={stage.count} aria-valuetext={`${stage.count} requests, ${stage.share}% of all requests`}>
                    <span style={{ height: `${(stage.count / dashboardPerformanceMax) * 100}%`, minHeight: stage.count ? '4px' : '0' }} />
                  </div>
                  <span className="admin-performance-label">{stage.label}</span>
                </div>)}
              </div>
              <p className="admin-performance-note">Live status counts only; this view does not measure processing time.</p>
            </section>
          </>}
          {adminView === 'overview' && <CommunityUpdatesCalendar
            updates={communityUpdates}
            isUpdateUnread={isAdminCommunityUpdateUnread}
            onViewUpdate={markAdminCommunityUpdateRead}
          />}
          {adminView === 'announcements' && <section className="admin-announcement-workspace">
            <header className="admin-announcement-hero">
              <div className="admin-announcement-hero-copy">
                <span className="section-number">COMMUNITY BULLETIN</span>
                <h2>Announcements &amp; events</h2>
                <p>Share barangay news, activities, and important schedules with residents.</p>
              </div>
              <div className="admin-announcement-hero-actions">
                <div className="admin-announcement-counts" aria-label="Published update totals">
                  <div><strong>{communityUpdates.filter((update) => update.type !== 'event').length}</strong><span>Announcements</span></div>
                  <div><strong>{communityUpdates.filter((update) => update.type === 'event').length}</strong><span>Events</span></div>
                </div>
              </div>
            </header>
            {(() => {
             const officeSchedule = officialAvailability.find((official) => official.id === 'secretary')
             const officeDays = officeSchedule?.days || []
             const todayDay = new Date().getDay()
             const todayLabel = weekDaysMondayFirst.find(({ day }) => day === todayDay)?.label || ''
             const hasTodayOverride = officeSchedule?.todayOverrideDate === todayDateInput && typeof officeSchedule?.isOpenToday === 'boolean'
             const isOfficeOpenToday = hasTodayOverride ? officeSchedule.isOpenToday : officeDays.includes(todayDay)
             return <section className="announcement-office-availability" aria-label="Barangay office availability">
               <article className="office-availability-card">
                 <div className="office-availability-heading">
                   <span className="office-availability-icon" aria-hidden="true">⌂</span>
                   <div><span className="office-availability-eyebrow">LIVE OFFICE SCHEDULE</span><h3>Barangay office</h3><p>Service hours follow the Barangay Secretary’s schedule.</p></div>
                   <span className={`office-availability-status ${isOfficeOpenToday ? 'is-scheduled' : ''}`} aria-live="polite">{isOfficeOpenToday ? 'Open today' : 'Closed today'}</span>
                 </div>
                 <div className="office-availability-details">
                   <div><span>Service hours</span><strong>{officeSchedule?.hours || 'Schedule not set'}</strong></div>
                   <div className="office-days-schedule"><span>Regular office days</span><div className="office-day-chips" aria-label="Weekly office schedule">{weekDaysMondayFirst.map(({ label, day }) => <span className={`office-day-chip${officeDays.includes(day) ? ' is-regular-day' : ''}${day === todayDay ? ' is-today' : ''}`} aria-current={day === todayDay ? 'date' : undefined} key={day}>{label}{day === todayDay && <small>Today</small>}</span>)}</div></div>
                   <div className="office-today-management">
                     <span>Today · {todayLabel}</span>
                     <button type="button" className="office-today-toggle" aria-pressed={isOfficeOpenToday} onClick={() => setOfficeOpenForToday(!isOfficeOpenToday)}>{isOfficeOpenToday ? 'Mark closed today' : 'Mark open today'}</button>
                     {hasTodayOverride && <button type="button" className="office-today-reset" onClick={restoreOfficeWeeklySchedule}>Use regular schedule</button>}
                   </div>
                 </div>
               </article>
             </section>
            })()}
            <section className="community-management-panel admin-announcement-management">
            <div className="requests-heading admin-announcement-list-heading">
              <div><span className="section-number">PUBLISHED UPDATES</span><h2>Manage community posts</h2><p>Edits and new posts are shared with residents in the community section.</p></div>
              <button type="button" className="admin-announcement-add-button" aria-expanded={communityUpdateFormOpen} aria-controls="community-update-form" onClick={() => setCommunityUpdateFormOpen((isOpen) => !isOpen)}>{communityUpdateFormOpen ? 'Close editor' : '＋ Add update'}</button>
            </div>
            {communityUpdateFormOpen && <form id="community-update-form" className="community-update-form" onSubmit={saveCommunityUpdate}>
              <div className="community-update-fields">
                <div><label htmlFor="community-update-type">Type</label><select id="community-update-type" value={communityUpdateForm.type} onChange={(event) => updateCommunityUpdateField('type', event.target.value)}><option value="announcement">Announcement</option><option value="event">Event</option></select></div>
                <div><label htmlFor="community-update-title">Title</label><input id="community-update-title" value={communityUpdateForm.title} onChange={(event) => updateCommunityUpdateField('title', event.target.value)} maxLength={100} required /></div>
                <div><label htmlFor="community-update-date">Date</label><input id="community-update-date" type="date" value={communityUpdateForm.date} onChange={(event) => updateCommunityUpdateField('date', event.target.value)} required /></div>
                <div><label htmlFor="community-update-location">Location</label><input id="community-update-location" value={communityUpdateForm.location} onChange={(event) => updateCommunityUpdateField('location', event.target.value)} maxLength={120} placeholder="Where will it take place?" /></div>
                <div><label htmlFor="community-update-start-time">Start time (optional)</label><input id="community-update-start-time" type="time" value={communityUpdateForm.startTime} onChange={(event) => updateCommunityUpdateField('startTime', event.target.value)} /></div>
                <div><label htmlFor="community-update-end-time">End time (optional)</label><input id="community-update-end-time" type="time" value={communityUpdateForm.endTime} onChange={(event) => updateCommunityUpdateField('endTime', event.target.value)} /></div>
                <div className="community-update-detail"><label htmlFor="community-update-description">Description (optional)</label><textarea id="community-update-description" value={communityUpdateForm.description} onChange={(event) => updateCommunityUpdateField('description', event.target.value)} maxLength={1000} rows={3} placeholder="Add more information for residents" /></div>
                <div className="community-update-image-field">
                  <label htmlFor="community-update-image">Picture or memorandum (optional)</label>
                  <input ref={communityUpdateImageInputRef} id="community-update-image" type="file" accept="image/*" onChange={(event) => uploadCommunityUpdateImage(event.target.files?.[0])} />
                  {communityUpdateImage && <div className="community-update-image-preview"><img src={communityUpdateImage.dataUrl} alt="Selected announcement image preview" /><span>{communityUpdateImage.fileName}</span><button type="button" className="community-cancel-button" onClick={() => { setCommunityUpdateImage(null); if (communityUpdateImageInputRef.current) communityUpdateImageInputRef.current.value = '' }}>Remove image</button></div>}
                </div>
              </div>
              {communityUpdateTimeError && <p className="community-update-error" role="alert">{communityUpdateTimeError}</p>}
              {communityUpdateImageError && <p className="community-update-error" role="alert">{communityUpdateImageError}</p>}
              <div className="community-update-actions">
                <button type="submit" className="check-button">{editingUpdateId ? 'Save changes' : 'Publish update'}</button>
                {editingUpdateId && <button type="button" className="community-cancel-button" onClick={resetCommunityUpdateForm}>Cancel edit</button>}
              </div>
            </form>}
            {communityUpdatesError && <p className="community-update-error" role="alert">{communityUpdatesError}</p>}
            <div className="community-update-list">
              {communityUpdates.map((update) => {
                const dateParts = getUpdateDateParts(update.date)
                return <article className="community-update-item" key={update.id}>
                  <div className="community-update-date"><strong>{dateParts.day}</strong><span>{dateParts.month}</span></div>
                  <div className="community-update-copy"><span className="update-type-label">{update.type === 'event' ? 'Event' : 'Announcement'}</span><strong>{update.title}</strong><CommunityUpdateContent update={update} /></div>
                  <div className="community-item-actions"><button type="button" onClick={() => editCommunityUpdate(update)}>Edit</button><button type="button" className="community-delete-button" onClick={() => deleteCommunityUpdate(update)} aria-label={`Delete ${update.title}`}>Delete</button></div>
                </article>
              })}
              {!communityUpdates.length && <p className="empty-updates">No announcements or events yet. Add one above.</p>}
            </div>
           </section>
          </section>}
          {adminView === 'documents' && <div className="document-request-workspace">
            {!selectedRequestId && <div className="request-search-panel document-request-search-panel">
              <div className="request-search-panel-heading"><span className="section-number">FIND A REQUEST</span><strong>Search and filter documents</strong></div>
              <div className="request-search-panel-controls">
                <label className="request-search">
                  <span>Search requests</span>
                  <input type="search" value={requestSearch} onChange={(event) => setRequestSearch(event.target.value)} placeholder="Resident, request ID, document, or status" />
                </label>
                <label className="request-document-filter">Document type
                  <select value={requestDocumentFilter} onChange={(event) => setRequestDocumentFilter(event.target.value)}>
                    <option value="all">All document types</option>
                    {requestDocumentOptions.map((document) => <option value={document} key={document}>{document}</option>)}
                  </select>
                </label>
                <p className="request-result-count" aria-live="polite">Showing <strong>{filteredResidentRequests.length}</strong> of {activeQueueRequests.length} active requests</p>
                {(requestSearch || requestDocumentFilter !== 'all') && <button type="button" className="request-filter-reset" onClick={() => { setRequestSearch(''); setRequestDocumentFilter('all') }}>Clear filters</button>}
              </div>
            </div>}
            <section className="requests-panel document-requests-panel">
            <div className="requests-heading">
              <div><span className="section-number">{selectedRequestId ? 'REQUEST REVIEW' : 'DOCUMENT INBOX'}</span><h2>{selectedRequestId ? 'Review resident request' : 'Active request queue'}</h2></div>
            </div>
            {selectedRequestId && <button type="button" className="open-request request-review-back" onClick={() => setSelectedRequestId(null)}>← Back to resident requests</button>}
            {!selectedRequestId && <>
            <div className="document-queue-stats" aria-label="Filter requests by category">
              {[
                ['incoming', 'Incoming requests'],
                ['review', 'Under review'],
                ['processing', 'Processing documents'],
                ['release', 'Ready for release'],
              ].map(([filter, label], index) => <button type="button" key={filter} data-step={`0${index + 1}`} className={`document-queue-stat ${documentQueueFilter === filter ? 'active' : ''}`} aria-pressed={documentQueueFilter === filter} onClick={() => { setDocumentQueueFilter(filter); setSelectedResidentGroupId(null) }}><span>{label}</span><strong>{documentQueueCounts[filter]}</strong></button>)}
            </div>
            <div className="request-results-heading">
              <span>Request</span>
              <span>Resident &amp; requested documents</span>
              <span>Current status</span>
              <span>Action</span>
            </div></>}
            <div className="request-list">
              {requestListEntries.map((entry) => {
                if (entry.type === 'resident') {
                  const requests = entry.requests
                  const firstRequest = requests[0]
                  const isExpanded = selectedResidentGroupId === entry.key
                  const hasUnviewedRequest = requests.some((request) => isDocumentWorkflowUnviewed(request, documentWorkflowViewedState))
                  const documents = [...new Set(requests.flatMap((request) => request.documents || []))]
                  const receivedDate = firstRequest.requestedAt
                    ? new Date(firstRequest.requestedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
                    : firstRequest.date || 'Date not recorded'
                  return (
                    <article className={`request-item submission-request-group${isExpanded ? ' is-expanded' : ''}${hasUnviewedRequest ? ' is-workflow-unviewed' : ''}`} key={entry.key}>
                      <div className="request-meta"><span>{requests.length} requests</span><small>Most recent: {receivedDate}</small></div>
                      <div className="request-resident">
                        <button
                          type="button"
                          className="request-resident-name-button"
                          aria-expanded={isExpanded}
                          aria-controls={`resident-requests-${encodeURIComponent(entry.key)}`}
                          onClick={() => {
                            if (!isExpanded) requests.forEach(markDocumentWorkflowViewed)
                            setSelectedResidentGroupId(isExpanded ? null : entry.key)
                          }}
                        >
                          {firstRequest.resident}
                        </button>
                        <div className="request-document-tags">{documents.map((document, index) => <span key={`${document}-${index}`}>{document}</span>)}</div>
                        <small>{requests.length} separate requests from this resident · {requests.some((request) => request.paymentStatus === 'Pending verification') ? 'payment verification pending' : 'select one to review'}</small>
                      </div>
                      <div className="request-status">
                        <span className="request-status-label">Current status</span>
                        <span className="compliance-status new">{requests.some((request) => request.paymentStatus === 'Pending verification') ? 'Payment verification pending' : `${requests.length} separate requests`}</span>
                      </div>
                      <button
                        type="button"
                        className="open-request"
                        aria-expanded={isExpanded}
                        aria-controls={`resident-requests-${encodeURIComponent(entry.key)}`}
                        onClick={() => {
                          if (!isExpanded) requests.forEach(markDocumentWorkflowViewed)
                          setSelectedResidentGroupId(isExpanded ? null : entry.key)
                        }}
                      >
                        {isExpanded ? 'Hide requests' : 'View requests'}<span aria-hidden="true">{isExpanded ? '−' : '→'}</span>
                      </button>
                      {isExpanded && (
                        <section className="submission-request-chooser" id={`resident-requests-${encodeURIComponent(entry.key)}`} aria-label={`${requests.length} requests from ${firstRequest.resident}`}>
                          <div className="submission-request-chooser-heading">
                            <strong>Requests from {firstRequest.resident}</strong>
                            <span>Each request keeps its own submission date, details, requirements, and status.</span>
                          </div>
                          {requests.map((request) => {
                            const copyCount = Number(request.copyCount) || 1
                            const requestDate = request.requestedAt
                              ? new Date(request.requestedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
                              : request.date || 'Date not recorded'
                            return (
                              <article className="submission-request-choice" key={request.id}>
                                <div>
                                  <strong>{request.documents?.join(' · ') || 'Document request'}</strong>
                                  <span>{request.id} · {requestDate} · {request.paymentStatus === 'Pending verification' ? 'Payment verification pending' : residentStatusLabels[request.status] || request.status} · {copyCount} {copyCount === 1 ? 'copy' : 'copies'} · ₱{Number(request.feeAmount || 0).toFixed(2)}</span>
                                </div>
                                <div className="submission-request-choice-actions">
                                  <button type="button" className="open-request" onClick={() => {
                                    markDocumentWorkflowViewed(request)
                                    setSelectedRequestId(request.id)
                                    setSelectedResidentGroupId(null)
                                  }}>
                                    Open this request<span aria-hidden="true">→</span>
                                  </button>
                                  {request.status === 'Ready for release' && request.pickupNotificationSentAt && <button
                                    type="button"
                                    className="approve-button"
                                    onClick={() => markRequestAsReceived(request, {
                                      releasedTo: request.resident,
                                      orNumber: request.orNumber || 'N/A',
                                      issuingOfficer: request.issuingOfficer || 'Barangay Official',
                                    })}
                                  >
                                    Mark as released
                                  </button>}
                                </div>
                              </article>
                            )
                          })}
                        </section>
                      )}
                    </article>
                  )
                }
                const request = entry.request
                const submissionEvidence = request.philsysVerificationEvidence
                  || residentRequests.find((candidate) => (
                    candidate.submissionId
                    && candidate.submissionId === request.submissionId
                    && candidate.philsysVerificationEvidence
                  ))?.philsysVerificationEvidence
                const residentPhotos = [
                  ...getRequestPhotos(request),
                  ...(submissionEvidence?.dataUrl?.startsWith('data:image/')
                    ? [{
                      photoKey: philsysEvidencePhotoKey,
                      label: 'PhilSys verification evidence',
                      fileName: submissionEvidence.fileName || '',
                      dataUrl: submissionEvidence.dataUrl,
                    }]
                    : []),
                ]
                const isIncomingRequest = ['New', 'For Verification'].includes(request.status)
                const isPaymentNotVerified = Number(request.feeAmount || 0) > 0 && request.paymentStatus !== 'Paid'
                const isPaymentVerificationPending = Number(request.feeAmount || 0) > 0 && request.paymentStatus === 'Pending verification'
                const relatedPaymentRecord = adminPaymentRecords.find((payment) => payment.requestIds.includes(request.id))
                const isVerificationRequest = selectedRequestId === request.id || ['New', 'For Verification', 'Under review', 'Returned for edits'].includes(request.status)
                const officialProcessingTitle = ({
                  'Under review': 'Review decision',
                  'Ready for release': 'Pickup & release',
                  'Approved - scheduling': 'Prepare documents',
                  'Returned for edits': 'Awaiting corrections',
                  Completed: 'Request complete',
                  Declined: 'Request closed',
                })[request.status] || 'Start request review'
                const requestDocuments = request.documents || []
                const requestRequirements = request.requirements || []
                const isWorkflowUnviewed = isDocumentWorkflowUnviewed(request, documentWorkflowViewedState)
                return (
                <article className={`request-item${isWorkflowUnviewed ? ' is-workflow-unviewed' : ''} ${selectedRequestId === request.id ? 'is-open request-review-page-item' : ''}`} key={request.id}>
                  {selectedRequestId !== request.id && <>
                  <div className="request-meta"><span>{request.id}</span><small>{request.requestedAt ? new Date(request.requestedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : request.date || 'Date not recorded'}</small></div>
                  <div className="request-resident">
                    <strong>{request.resident}</strong>
                    <div className="request-document-tags">{request.documents?.length ? request.documents.map((document) => <span key={document}>{document}</span>) : <span>No documents listed</span>}</div>
                    <small>{Number(request.copyCount) || 1} {Number(request.copyCount) === 1 ? 'copy' : 'copies'} · ₱{Number(request.feeAmount || 0).toFixed(2)}</small>
                  </div>
                  <div className="request-status"><span className="request-status-label">Current status</span><span className="request-status-value"><span className={`compliance-status ${isPaymentVerificationPending ? 'pending' : request.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{isPaymentVerificationPending ? 'Payment verification pending' : residentStatusLabels[request.status] || request.status}</span>{isWorkflowUnviewed && <span className="resident-request-new-dot" role="img" aria-label="New request update" title="New request update" />}</span></div>
                  {request.status === 'Ready for release' ? (
                    <div className="ready-request-actions">
                      <button type="button" className="open-request" onClick={() => {
                        setSelectedRequestId(request.id)
                        setReleaseForm({ requestId: '', releasedTo: '', orNumber: '', issuingOfficer: '' })
                        setReleaseFormError('')
                      }} aria-controls={`request-detail-${request.id}`}>View<span aria-hidden="true">→</span></button>
                      {request.pickupNotificationSentAt && <button
                        type="button"
                        className="approve-button"
                        onClick={() => markRequestAsReceived(request, {
                          releasedTo: request.resident,
                          orNumber: request.orNumber || 'N/A',
                          issuingOfficer: request.issuingOfficer || 'Barangay Official',
                        })}
                      >
                        Mark as released
                      </button>}
                    </div>
                  ) : <button type="button" className="open-request" onClick={() => setSelectedRequestId(request.id)} aria-expanded={selectedRequestId === request.id} aria-controls={`request-detail-${request.id}`}>{isPaymentVerificationPending ? 'View request' : 'Open request'}<span aria-hidden="true">→</span></button>}
                  </>}
                  {selectedRequestId === request.id && (
                    <div className="request-detail" id={`request-detail-${request.id}`}>
                      <div className="request-review-page-heading"><div><p className="detail-label">Resident request</p><h3>{request.resident}</h3><span>{request.id} · {request.requestedAt ? new Date(request.requestedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : request.date || 'Date not recorded'}</span></div><span className={`compliance-status ${isPaymentVerificationPending ? 'pending' : request.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{isPaymentVerificationPending ? 'Payment verification pending' : residentStatusLabels[request.status] || request.status}</span></div>
                      {isIncomingRequest ? (
                        <section className="incoming-request-preview" aria-label="Incoming request summary">
                          <header className="incoming-request-intro">
                            <span className="incoming-request-preview-icon" aria-hidden="true">
                              <svg viewBox="0 0 24 24"><path d="M12 3.5 19 6v5.2c0 4.2-2.8 7.5-7 9.3-4.2-1.8-7-5.1-7-9.3V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg>
                            </span>
                            <div className="incoming-request-intro-copy">
                              <div className="incoming-request-eyebrow"><span className="section-number">INCOMING APPLICATION</span><span className="incoming-request-state"><i aria-hidden="true" /> Awaiting review</span></div>
                              <h4>Request received</h4>
                              <p>{isPaymentNotVerified ? 'Payment must be verified before document review can begin.' : 'Check the application summary before opening the resident’s submitted information.'}</p>
                            </div>
                          </header>

                          <dl className="incoming-request-metrics" aria-label="Request summary">
                            <div><dt>Documents requested</dt><dd>{requestDocuments.length}</dd></div>
                            <div><dt>Requirements listed</dt><dd>{requestRequirements.length}</dd></div>
                            <div><dt>Copies requested</dt><dd>{Number(request.copyCount) || 1}</dd></div>
                            <div><dt>Total fee</dt><dd>₱{Number(request.feeAmount || 0).toFixed(2)}</dd></div>
                          </dl>

                          {isPaymentVerificationPending && (
                            <>
                              <section className="incoming-request-panel" aria-label="Submitted resident information">
                                <header><span className="incoming-request-panel-icon" aria-hidden="true">i</span><div><h5>Submitted resident information</h5><p>Information provided with the document request</p></div></header>
                                <dl className="resident-details">
                                  {getSubmittedRequestFields(request, customCertificateTemplates).map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}
                                  {!getSubmittedRequestFields(request, customCertificateTemplates).length && <div><dt>Information</dt><dd>No additional certificate details were submitted.</dd></div>}
                                </dl>
                              </section>
                              <section className="incoming-request-panel payment-proof-review-panel" aria-label="Submitted payment proof">
                                <header><span className="incoming-request-panel-icon" aria-hidden="true">₱</span><div><h5>Payment proof</h5><p>Verify this receipt before starting document review</p></div></header>
                                <dl className="resident-details">
                                  <div><dt>Payment method</dt><dd>{request.paymentMethod === 'walk-in' ? 'Walk-in at Barangay Hall' : request.paymentMethod === 'gcash' ? 'GCash transfer' : request.paymentMethod || 'Not provided'}</dd></div>
                                  <div><dt>Reference number</dt><dd>{request.paymentProofOrNumber || 'Not provided'}</dd></div>
                                  <div><dt>Submitted</dt><dd>{request.paymentSubmittedAt ? new Date(request.paymentSubmittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded'}</dd></div>
                                </dl>
                                {request.paymentProof?.dataUrl && <a className="payment-proof-preview" href={request.paymentProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.paymentProof.dataUrl} alt={`Payment receipt for ${request.id}`} /><span>{request.paymentProof.fileName || 'View payment proof'}</span></a>}
                                <button type="button" className="open-request" onClick={() => {
                                  markAdminNavigationSectionRead('payments')
                                  setAdminView('payments')
                                  setPaymentReviewRequestId(relatedPaymentRecord?.id || '')
                                  setPaymentOrNumber(relatedPaymentRecord?.paymentOrNumber || '')
                                }}>Open payment tracking<span aria-hidden="true">→</span></button>
                              </section>
                            </>
                          )}

                          <div className="incoming-request-panels">
                            <section className="incoming-request-panel">
                              <header><span className="incoming-request-panel-icon" aria-hidden="true">▤</span><div><h5>Requested documents</h5><p>Certificates included in this application</p></div><span className="incoming-request-panel-count">{requestDocuments.length}</span></header>
                              {requestDocuments.length ? (
                                <ul>{requestDocuments.map((document, index) => <li key={`${document}-${index}`}><span className="incoming-request-list-index">{String(index + 1).padStart(2, '0')}</span><span>{document}</span></li>)}</ul>
                              ) : <p className="incoming-request-empty">No documents were listed.</p>}
                            </section>
                            <section className="incoming-request-panel">
                              <header><span className="incoming-request-panel-icon" aria-hidden="true">✓</span><div><h5>Requirements</h5><p>Items provided for verification</p></div><span className="incoming-request-panel-count">{requestRequirements.length}</span></header>
                              {requestRequirements.length ? (
                                <ul>{requestRequirements.map((requirement, index) => <li key={`${requirement}-${index}`}><span className="incoming-request-requirement-check" aria-hidden="true">✓</span><span>{requirement}</span></li>)}</ul>
                              ) : <p className="incoming-request-empty">No additional requirements were listed.</p>}
                            </section>
                          </div>

                          <footer className="incoming-request-footer">
                            <div className="incoming-request-privacy">
                              <span aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg></span>
                              <div><strong>Resident information stays private</strong><p>Personal details and uploaded photos are hidden until you begin the review.</p></div>
                            </div>
                            <button type="button" className="incoming-review-button" disabled={isPaymentNotVerified} onClick={() => recordAction(request.id, 'Started review')}>
                              {isPaymentNotVerified ? 'Verify payment first' : 'Review'}
                            </button>
                          </footer>
                          <ol className="incoming-request-steps" aria-label="Request process">
                            <li className="is-complete"><span>1</span><div><strong>Received</strong><small>Application submitted</small></div></li>
                            <li className="is-current"><span>2</span><div><strong>Under review</strong><small>Check information and requirements</small></div></li>
                            <li><span>3</span><div><strong>Decision</strong><small>Approve or request changes</small></div></li>
                          </ol>
                        </section>
                      ) : request.status === 'Ready for release' ? (
                        <div className="ready-processing-modal-backdrop" onMouseDown={(event) => {
                          if (event.target === event.currentTarget) setSelectedRequestId(null)
                        }}>
                          <section className={`ready-processing-modal${readyForm.requestId === request.id ? ' is-pickup-details-open' : ''}`} role="dialog" aria-modal="true" aria-labelledby={`ready-processing-title-${request.id}`}>
                            <header className="pickup-schedule-modal-header">
                              <div>
                                <span className="section-number">{request.pickupNotificationSentAt ? 'EDIT PICKUP SCHEDULE' : 'OFFICIAL PROCESSING'}</span>
                                <h3 id={`ready-processing-title-${request.id}`}>Ready for release</h3>
                                <p>{request.resident} · {request.id}</p>
                              </div>
                              <button type="button" className="pickup-modal-close" aria-label="Close official processing" onClick={() => setSelectedRequestId(null)}>×</button>
                            </header>
                            <div className="ready-processing-status"><span aria-hidden="true">✓</span><div><strong>Documents prepared</strong><small>{request.documents.length} {request.documents.length === 1 ? 'document is' : 'documents are'} ready for pickup</small></div></div>
                            <section className="ready-processing-documents" aria-label="Documents ready for pickup">
                              <h4>Documents in this request</h4>
                              <ul>{request.documents.map((document) => <li key={document}><span aria-hidden="true">✓</span>{document}</li>)}</ul>
                            </section>
                            <div className="ready-processing-schedule">
                              <div className="ready-processing-schedule-heading"><span aria-hidden="true">⌖</span><strong>PICKUP SCHEDULE</strong></div>
                              <span className="ready-processing-schedule-value">{request.pickupDate && request.pickupTime ? formatPickupSchedule(request.pickupDate, request.pickupTime) : 'Not scheduled yet'}</span>
                              <span>{request.pickupInstructions || 'Set a date, time, and location to let the resident know when to collect the documents.'}</span>
                              <span className={`ready-processing-notification${request.pickupNotificationSentAt ? ' is-sent' : ''}`}><i aria-hidden="true" />{request.pickupNotificationSentAt ? 'Pickup information sent to resident' : 'Resident has not been notified yet'}</span>
                            </div>
                            <div className="ready-for-release">
                              {readyForm.requestId !== request.id ? (
                                <button type="button" className="pickup-action-button" onClick={() => startReadyForRelease(request)}>
                                  <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M8 13h3M8 16.5h3" /></svg>
                                  <span>{request.pickupNotificationSentAt ? 'Edit pickup details' : 'Set pickup details'}</span>
                                  <span className="pickup-action-caption">{request.pickupNotificationSentAt ? 'Revise date, time, and location' : 'Set date, time, and location'}</span>
                                </button>
                              ) : createPortal(
                                <div className="pickup-schedule-modal-backdrop pickup-details-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeReadyForRelease() }}>
                                  <section className="pickup-schedule-modal" role="dialog" aria-modal="true" aria-labelledby={`pickup-modal-title-${request.id}`}>
                                    <header className="pickup-schedule-modal-header">
                                      <div><span className="section-number">READY FOR RELEASE</span><h3 id={`pickup-modal-title-${request.id}`}>{isReviewingReadyForm ? 'Review pickup details' : request.pickupNotificationSentAt ? 'Edit pickup details' : 'Set pickup details'}</h3><p>For {request.resident}</p></div>
                                      <button type="button" className="pickup-modal-close" aria-label="Close pickup details" onClick={closeReadyForRelease}>×</button>
                                    </header>
                                    <div className="pickup-request-summary">
                                      <div className="pickup-request-summary-icon" aria-hidden="true">
                                        <svg viewBox="0 0 24 24"><path d="M7 4.5h10a2 2 0 0 1 2 2v13H5v-13a2 2 0 0 1 2-2Z" /><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4" /></svg>
                                      </div>
                                      <div className="pickup-request-summary-item"><span>REQUEST REFERENCE</span><strong>{request.id}</strong></div>
                                      <div className="pickup-request-summary-item"><span>DOCUMENTS</span><strong>{request.documents.length} {request.documents.length === 1 ? 'document' : 'documents'}</strong></div>
                                    </div>
                                    {isReviewingReadyForm ? (
                                      <section className="pickup-details-review" aria-label="Review pickup details before sending">
                                        <p>Review these details before sending the pickup information to the resident.</p>
                                        <dl className="pickup-review-details">
                                          <div><dt>Pickup schedule</dt><dd>{new Date(`${readyForm.pickupDate}T${readyForm.pickupTime}`).toLocaleString('en-PH', { dateStyle: 'long', timeStyle: 'short' })}</dd></div>
                                          <div><dt>Location &amp; instructions</dt><dd>{readyForm.pickupInstructions}</dd></div>
                                        </dl>
                                        {readyFormError && <p className="community-update-error" role="alert">{readyFormError}</p>}
                                        <div className="pickup-modal-actions"><button type="button" className="cancel-button" onClick={() => setIsReviewingReadyForm(false)}>Edit details</button><button type="button" className="pickup-submit-button" onClick={() => sendPickupDetails(request)}>{request.pickupNotificationSentAt ? 'Confirm & send update' : 'Send pickup details to resident'}</button></div>
                                      </section>
                                    ) : (
                                      <form className="ready-schedule-form" onSubmit={(event) => setRequestReadyForRelease(event, request)}>
                                        <div className="pickup-form-step-heading"><span>COLLECTION ARRANGEMENT</span><strong>Enter pickup details</strong></div>
                                        <label>Pickup date<input type="date" min={getLocalDateInputValue()} value={readyForm.pickupDate} onChange={(event) => setReadyForm({ ...readyForm, pickupDate: event.target.value })} required /></label>
                                        <label>Pickup time<input type="time" value={readyForm.pickupTime} onChange={(event) => setReadyForm({ ...readyForm, pickupTime: event.target.value })} required /></label>
                                        <label>Pickup location and instructions<textarea value={readyForm.pickupInstructions} onChange={(event) => setReadyForm({ ...readyForm, pickupInstructions: event.target.value })} placeholder="Barangay office location and what to bring" rows="3" required /></label>
                                        {readyFormError && <p className="community-update-error" role="alert">{readyFormError}</p>}
                                        <div className="pickup-modal-actions"><button type="submit" className="pickup-submit-button">Review pickup details</button></div>
                                      </form>
                                    )}
                                  </section>
                                </div>,
                                document.body,
                              )}
                            </div>
                          </section>
                        </div>
                      ) : (
                      <div className="request-review-content">
                        <div className="request-review-main">
                          <section className="request-review-section">
                            <p className="detail-label">Submitted resident information</p>
                            <dl className="resident-details">{getSubmittedRequestFields(request, customCertificateTemplates).map(({ key, label, value }) => <div key={key}><dt>{label}</dt><dd>{value}</dd></div>)}{!getSubmittedRequestFields(request, customCertificateTemplates).length && <div><dt>Information</dt><dd>No requested certificate details were submitted</dd></div>}</dl>
                          </section>
                          <section className="request-review-section">
                            <p className="detail-label">Requested documents and requirements</p>
                            <ul className="detail-list">{request.documents.map((document) => <li key={document}>{document}</li>)}{(request.requirements || []).map((requirement) => <li key={requirement}>{requirement}</li>)}</ul>
                          </section>
                          {isVerificationRequest && (
                            <section className="request-review-section submitted-evidence" aria-label={`Resident photos for ${request.resident}`}>
                              <div className="verification-id-heading"><strong>Resident photos</strong><span>{residentPhotos.length} attached</span></div>
                              {residentPhotos.length ? (
                                <div className="submitted-evidence-grid">
                                  {residentPhotos.map((photo) => (
                                    <div className="submitted-evidence-card" key={photo.photoKey}>
                                      <figure className="submitted-evidence-item">
                                        <button type="button" className="request-evidence-image-button" onClick={() => setSelectedVerificationPhoto({ ...photo, resident: request.resident })} aria-label={`Review full-size ${photo.label}`}>
                                          <img src={photo.dataUrl} alt={`${photo.label} submitted by ${request.resident}`} loading="lazy" />
                                        </button>
                                        <figcaption><button type="button" onClick={() => setSelectedVerificationPhoto({ ...photo, resident: request.resident })}>Review full size</button>{photo.fileName && <small>{photo.fileName}</small>}</figcaption>
                                      </figure>
                                      <div className="evidence-photo-title">{photo.label}</div>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="evidence-empty">No viewable resident photos were saved with this request.</p>
                              )}
                            </section>
                          )}
                        </div>
                        <aside className="request-review-sidebar">
                          <section className="processing-area request-review-section" onClick={(event) => event.stopPropagation()}>
                            <header className="official-processing-heading">
                              <span className="official-processing-icon" aria-hidden="true">✓</span>
                              <div><span className="section-number">OFFICIAL PROCESSING</span><h4>{officialProcessingTitle}</h4><p>Manage the current step for this request.</p></div>
                            </header>
                            {request.status === 'Ready for release' && <div className="pickup-date">
                              <strong>Pickup schedule</strong>
                              <span>{request.pickupDate ? formatPickupSchedule(request.pickupDate, request.pickupTime) : 'Not set yet'}</span>
                              {request.pickupInstructions && <span>{request.pickupInstructions}</span>}
                              <span>{request.pickupNotificationSentAt ? 'Pickup information sent to resident' : 'Pickup information has not been sent to resident'}</span>
                            </div>}
                            {request.documentsApprovedAt && request.status !== 'Declined' && request.status !== 'Ready for release' && (
                              <button
                                type="button"
                                className="open-request certificate-processing-link"
                                onClick={() => {
                                  setSelectedRequestId(null)
                                  setCertificateProcessingRequestId(request.id)
                                  setCertificateProcessingRequestGroupIds([request.id])
                                  setCertificateProcessingDocument(null)
                                  setHighlightedCertificateTemplate(getCertificateTemplateTarget(request))
                                  setDocumentQueueFilter('processing')
                                  markAdminViewRead('certificateTemplates')
                                  setAdminView('certificateTemplates')
                                }}
                              >
                                Choose certificate template
                              </button>
                            )}
                            {request.status === 'Ready for release' ? (
                              <div className="ready-for-release">
                                <p>{request.pickupNotificationSentAt ? 'The resident has been sent the pickup information. Update it here if the schedule changes.' : 'The documents are ready. Choose when and where the resident can collect them, then send the pickup information.'}</p>
                                {readyForm.requestId !== request.id ? (
                                  <button type="button" className="pickup-action-button" onClick={() => startReadyForRelease(request)}>
                                    <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="16" rx="2" /><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M8 13h3M8 16.5h3" /></svg>
                                    <span>{request.pickupNotificationSentAt ? 'Update pickup details' : 'Set pickup details'}</span>
                                    <span className="pickup-action-caption">{request.pickupNotificationSentAt ? 'Change the schedule or instructions' : 'Choose when and where to collect'}</span>
                                  </button>
                                ) : (
                                  <div className="pickup-schedule-modal-backdrop" onMouseDown={(event) => {
                                    if (event.target === event.currentTarget) {
                                      setReadyForm({ requestId: '', pickupDate: '', pickupTime: '', pickupInstructions: '' })
                                      setReadyFormError('')
                                    }
                                  }}>
                                    <section className="pickup-schedule-modal" role="dialog" aria-modal="true" aria-labelledby={`pickup-modal-title-${request.id}`}>
                                      <header className="pickup-schedule-modal-header">
                                        <div><span className="section-number">READY FOR RELEASE</span><h3 id={`pickup-modal-title-${request.id}`}>{request.pickupNotificationSentAt ? 'Update pickup details' : 'Set pickup details'}</h3><p>For {request.resident}</p></div>
                                        <button type="button" className="pickup-modal-close" aria-label="Close pickup details" onClick={() => {
                                          setReadyForm({ requestId: '', pickupDate: '', pickupTime: '', pickupInstructions: '' })
                                          setReadyFormError('')
                                        }}>×</button>
                                      </header>
                                      <form className="ready-schedule-form" onSubmit={(event) => setRequestReadyForRelease(event, request)}>
                                        <label>Pickup date<input type="date" min={getLocalDateInputValue()} value={readyForm.pickupDate} onChange={(event) => setReadyForm({ ...readyForm, pickupDate: event.target.value })} required /></label>
                                        <label>Pickup time<input type="time" value={readyForm.pickupTime} onChange={(event) => setReadyForm({ ...readyForm, pickupTime: event.target.value })} required /></label>
                                        <label>Pickup location and instructions<textarea value={readyForm.pickupInstructions} onChange={(event) => setReadyForm({ ...readyForm, pickupInstructions: event.target.value })} placeholder="Barangay office location and what to bring" rows="3" required /></label>
                                        {readyFormError && <p className="community-update-error" role="alert">{readyFormError}</p>}
                                        <div className="pickup-modal-actions"><button type="submit" className="pickup-submit-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 3.5v3M16.5 3.5v3M3.5 9.5h17M5.5 5h13a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" /><path d="m8 15 2.2 2.2L16 11.5" /></svg><span>{request.pickupNotificationSentAt ? 'Save changes & notify resident' : 'Set schedule & notify resident'}</span></button><button type="button" className="cancel-button" onClick={() => {
                                          setReadyForm({ requestId: '', pickupDate: '', pickupTime: '', pickupInstructions: '' })
                                          setReadyFormError('')
                                        }}>Cancel</button></div>
                                      </form>
                                    </section>
                                  </div>
                                )}
                                {request.pickupNotificationSentAt && <div className="document-release">
                                  {releaseForm.requestId !== request.id ? (
                                    <button type="button" className="approve-button" onClick={() => { setReleaseForm({ requestId: request.id, releasedTo: request.resident, orNumber: '', issuingOfficer: '' }); setReleaseFormError('') }}>Record document pickup</button>
                                  ) : (
                                    <form className="release-record-form" onSubmit={(event) => releaseRequest(event, request)}>
                                      <p className="detail-label">Mark documents as received</p>
                                      <label>Received by<input value={releaseForm.releasedTo} onChange={(event) => setReleaseForm({ ...releaseForm, releasedTo: event.target.value })} required /></label>
                                      <label>OR number<input value={releaseForm.orNumber} onChange={(event) => setReleaseForm({ ...releaseForm, orNumber: event.target.value })} placeholder="Enter OR number or N/A" required /></label>
                                      <label>Issuing officer<input value={releaseForm.issuingOfficer} onChange={(event) => setReleaseForm({ ...releaseForm, issuingOfficer: event.target.value })} required /></label>
                                      {releaseFormError && <p className="community-update-error" role="alert">{releaseFormError}</p>}
                                      <div className="action-buttons"><button type="submit" className="approve-button">Mark as released</button><button type="button" className="cancel-button" onClick={() => { setReleaseForm({ requestId: '', releasedTo: '', orNumber: '', issuingOfficer: '' }); setReleaseFormError('') }}>Cancel</button></div>
                                    </form>
                                  )}
                                </div>}
                              </div>
                            ) : request.status === 'Under review' ? (
                              <div className="action-buttons official-processing-actions">
                                <button type="button" className="approve-button" onClick={() => recordAction(request.id, 'Approved and forwarded to document processing')}>Approve &amp; start document processing</button>
                                <button type="button" onClick={() => startReturnRequestForEdits(request)}>Return for edits</button>
                                <button type="button" className="decline-button" onClick={startDeclineRequest}>Decline request</button>
                              </div>
                            ) : request.status === 'Returned for edits' ? (
                              <p className="request-review-hint">Review is paused until the resident submits the corrected files. The request will return to the incoming queue when the corrections are received.</p>
                            ) : ['New', 'For Verification'].includes(request.status) ? (
                              <>
                                <button type="button" className="approve-button" disabled={isPaymentNotVerified} onClick={() => recordAction(request.id, 'Started review')}>{isPaymentNotVerified ? 'Verify payment first' : 'Start review'}</button>
                              </>
                            ) : request.status === 'Approved - scheduling' ? (
                              <p className="request-review-hint">Prepare and print all approved certificates. Once complete, this request moves to Ready for release for pickup scheduling and resident notification.</p>
                            ) : request.status !== 'Declined' && request.status !== 'Completed' ? (
                              <p className="request-review-hint">This request is awaiting its next processing step.</p>
                            ) : null}
                            {showReturnEditsForm && request.status === 'Under review' && (
                              <form className="decline-form return-edits-form" onSubmit={(event) => returnRequestForEdits(event, request.id)}>
                                <p className="detail-label">Return request for edits</p>
                                <label htmlFor={`return-edits-note-${request.id}`}>Explain what the resident needs to correct</label>
                                <textarea id={`return-edits-note-${request.id}`} value={returnEditsNote} onChange={(event) => setReturnEditsNote(event.target.value)} placeholder="Describe the information or documents that need correction." required />
                                <fieldset className="invalid-requirements">
                                  <legend>Choose uploaded items that need replacement</legend>
                                  {getRequestPhotos(request).map((photo) => <label key={photo.photoKey}><input type="checkbox" checked={invalidRequirements.includes(photo.photoKey)} onChange={() => toggleInvalidRequirement(photo.photoKey)} />{photo.document ? `${photo.document} · ` : ''}{photo.label}{photo.fileName ? ` (${photo.fileName})` : ''}</label>)}
                                  {!getRequestPhotos(request).length && <p className="request-review-hint">No uploaded requirement photos were found. Add a clear note identifying what the resident needs to correct.</p>}
                                </fieldset>
                                <fieldset className="invalid-requirements">
                                  <legend>Choose certificate information to correct</legend>
                                  <p className="request-review-hint">Missing fields are selected automatically. You can also select any other information that needs correction.</p>
                                  {getCertificateCorrectionFields(request, customCertificateTemplates).map(({ document, field, correctionKey, missing }) => (
                                    <label className={missing ? 'is-missing' : ''} key={correctionKey}>
                                      <input type="checkbox" checked={invalidRequirements.includes(correctionKey)} onChange={() => toggleInvalidRequirement(correctionKey)} />
                                      <span>{document} · {field.label}</span>
                                      {missing && <small className="correction-field-missing">Missing</small>}
                                    </label>
                                  ))}
                                  {!getCertificateCorrectionFields(request, customCertificateTemplates).length && <p className="request-review-hint">No certificate information fields are available to correct.</p>}
                                </fieldset>
                                <div className="decline-form-actions"><button type="submit" className="approve-button" disabled={!returnEditsNote.trim() || !invalidRequirements.length}>Send edit instructions</button><button type="button" className="cancel-button" onClick={() => { setShowReturnEditsForm(false); setInvalidRequirements([]) }}>Cancel</button></div>
                              </form>
                            )}
                            {showDeclineForm && (
                              <form className="decline-form" onSubmit={(event) => declineRequest(event, request.id)}>
                                <p className="detail-label">Decline request</p>
                                <label htmlFor={`decline-reason-${request.id}`}>Why is this request being declined?</label>
                                <textarea id={`decline-reason-${request.id}`} value={declineReason} onChange={(event) => setDeclineReason(event.target.value)} placeholder="Explain what needs to be corrected before resubmitting." required />
                                <fieldset className="invalid-requirements">
                                  <legend>Requirements that did not pass validation</legend>
                                  {(request.requirements || []).map((requirement) => <label key={requirement}><input type="checkbox" checked={invalidRequirements.includes(requirement)} onChange={() => toggleInvalidRequirement(requirement)} />{requirement}</label>)}
                                </fieldset>
                                <div className="decline-form-actions"><button type="submit" className="decline-button" disabled={!invalidRequirements.length}>Confirm decline</button><button type="button" className="cancel-button" onClick={() => setShowDeclineForm(false)}>Cancel</button></div>
                              </form>
                            )}
                          </section>
                          <section className="request-review-section">
                            <p className="detail-label activity-heading">Action history</p>
                            <ol className="activity-list">{(request.activity || []).slice().reverse().map((entry, index) => <li key={`${entry.time}-${index}`}><strong>{entry.action}</strong><span>{entry.by} · {entry.time}</span></li>)}</ol>
                          </section>
                        </aside>
                      </div>
                      )}
                    </div>
                  )}
                </article>
                )
              })}
              {filteredResidentRequests.length === 0 && <p className="request-search-empty">{activeQueueRequests.length === 0 ? 'No active resident document requests yet.' : 'No active requests match this category, search, or document filter.'}</p>}
            </div>
            </section>
          </div>}
          {adminView === 'officials' && <section className="officials-admin-page green-startup-workspace">
            {officialPhotoError && <p className="official-photo-error-message" role="alert">{officialPhotoError}</p>}
            <button type="button" className="resident-add-form-toggle official-add-button" onClick={addOfficialProfile}><span aria-hidden="true">+</span>Add official</button>
            <div className="official-card-grid">{officialProfiles.map((official, index) => {
              const availabilityId = getOfficialAvailabilityId(index)
              const { schedule, days, hours } = getOfficialScheduleDetails(index)
              return <article className="official-admin-card" key={`${official.role}-${index}`}>
                <div className="official-photo">
                  <div className="official-photo-frame">
                    {officialPhotos[index] ? <img src={officialPhotos[index]} alt={`${official.name} portrait`} /> : <span className="official-admin-avatar">{official.name.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span>}
                  </div>
                  <label><input type="file" accept="image/*" aria-label={`Upload photo for ${official.role}`} onChange={(event) => updateOfficialPhoto(event, index)} />{officialPhotos[index] ? 'Change photo' : 'Add photo'}</label>
                </div>
                <div className="official-admin-card-content">
                  <span className="official-role-badge">0{index + 1} · {official.role || 'Official'}</span>
                  <h3>{official.name || 'Official name not set'}</h3>
                  <p>{official.description || 'No profile information added yet.'}</p>
                  <button type="button" className="official-details-toggle" aria-haspopup="dialog" onClick={() => setExpandedOfficialIndex(index)}>Edit details<span aria-hidden="true">↗</span></button>
                </div>
                <div className="official-schedule-editor">
                  <strong>Weekly schedule</strong>
                  <div className="day-selector" role="group" aria-label={`${official.role || official.name} available days`}>
                    {weekDaysMondayFirst.map(({ label, day }) => <label key={label}><input type="checkbox" checked={Boolean(schedule?.days?.includes(day))} onChange={() => toggleAvailabilityDay(availabilityId, day)} /><span>{label}</span></label>)}
                  </div>
                  <label className="official-schedule-hours"><span>Office hours / time</span><input type="text" value={schedule?.hours === 'Schedule not set' ? '' : schedule?.hours || ''} onChange={(event) => updateAvailabilityHours(availabilityId, index, event.target.value)} placeholder="e.g. 8:00 AM - 5:00 PM" /></label>
                  <div className="official-schedule-preview" aria-live="polite">
                    <span>Resident-facing schedule</span>
                    <strong>{days || 'Days not set'} · {hours || 'Time not set'}</strong>
                  </div>
                  {!schedule?.days?.length && <small>No days selected</small>}
                </div>
              </article>
            })}</div>
            {expandedOfficialIndex !== null && officialProfiles[expandedOfficialIndex] && <div className="official-edit-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setExpandedOfficialIndex(null) }}>
              <section className="official-edit-modal" role="dialog" aria-modal="true" aria-labelledby="official-edit-modal-title">
                <header className="official-edit-modal-header"><div><span className="section-number">PROFILE SETTINGS</span><h3 id="official-edit-modal-title">{officialProfiles[expandedOfficialIndex].name ? 'Edit official' : 'Add official'}</h3><p>Changes are saved automatically as you edit.</p></div><button type="button" className="official-edit-modal-close" onClick={() => setExpandedOfficialIndex(null)} aria-label="Close official editor">×</button></header>
                <div className="official-profile-fields">
                  <label className="official-profile-name-field">Full name<input autoFocus value={officialProfiles[expandedOfficialIndex].name} onChange={(event) => updateOfficialProfile(expandedOfficialIndex, 'name', event.target.value)} placeholder="Enter official's full name" /></label>
                  <label className="official-profile-position-field">Position<input value={officialProfiles[expandedOfficialIndex].role} onChange={(event) => updateOfficialProfile(expandedOfficialIndex, 'role', event.target.value)} placeholder="Enter position" /></label>
                  <label className="official-profile-note-field">Profile information<textarea value={officialProfiles[expandedOfficialIndex].description} onChange={(event) => updateOfficialProfile(expandedOfficialIndex, 'description', event.target.value)} placeholder="Describe this official's role and responsibilities" rows="5" /></label>
                </div>
                <footer className="official-edit-modal-footer"><button type="button" className="check-button" onClick={() => setExpandedOfficialIndex(null)}>Done</button></footer>
              </section>
            </div>}
          </section>}
          {adminView === 'registrations' && <div className="registration-requests-workspace registration-review-v2">
            <header className="registration-requests-heading">
              <div><span className="section-number">RESIDENT SERVICES / INTAKE</span><h2>Registration requests</h2><p>Review applicant details and supporting documents before recording a decision.{!officialBackendToken && <span className="registration-auth-note"> Backend account requests require authorized admin sign-in.</span>}</p></div>
              <div className="registration-requests-counts"><span><strong>{pendingRegistrationCount}</strong> awaiting review</span><span><strong>{registrationHistoryRequests.length}</strong> processed</span></div>
            </header>
            {registrationSyncError && <p className={`registration-sync-message${registrationSyncError.startsWith('The registration service is unavailable') ? ' is-info' : ''}`} role={registrationSyncError.startsWith('The registration service is unavailable') ? 'status' : 'alert'}>{registrationSyncError}</p>}
            <section className="registration-list-panel" aria-labelledby="registration-pending-title">
              <header className="registration-list-heading">
                <div><span className="section-number">INCOMING</span><h3 id="registration-pending-title">Pending applications <span>{pendingRegistrationCount}</span></h3><p>Open an application to review it step by step.</p></div>
                <label className="registration-page-search"><span aria-hidden="true">⌕</span><span className="sr-only">Search applications</span><input value={registrationQueueSearch} onChange={(event) => setRegistrationQueueSearch(event.target.value)} placeholder="Search name or request ID" /></label>
              </header>
              {filteredPendingRegistrationRequests.length
                ? <div className="registration-pending-list" role="list">{filteredPendingRegistrationRequests.map((request) => <article key={request.id} className={`registration-pending-row${expandedRegistrationId === request.id ? ' is-reviewing' : ''}`} role="listitem">
                  <div className="registration-pending-reference">
                    <span className="registration-pending-label">Request ID</span>
                    <strong className="registration-request-reference">{request.id}</strong>
                    <time dateTime={request.submittedAt || undefined}>{request.submittedAt ? new Date(request.submittedAt).toLocaleDateString('en-PH') : 'Date not recorded'}</time>
                  </div>
                  <div className="registration-pending-applicant">
                    <span className="registration-pending-label">Applicant</span>
                    <strong>{request.name}</strong>
                    <span className="registration-pending-address">{request.address || 'Address not recorded'}</span>
                    {request.residentUpdatedAt && <small className="registration-applicant-updated">Updated by applicant · {new Date(request.residentUpdatedAt).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</small>}
                  </div>
                  <div className="registration-pending-status">
                    <span className="registration-pending-label">Current status</span>
                    <span className={`registration-queue-status${request.referenceAccessStatus === 'Paused' ? ' is-paused' : ''}`}>{request.referenceAccessStatus === 'Paused' ? 'Needs information' : 'Pending'}</span>
                  </div>
                  <button type="button" className="registration-open-review" aria-expanded={expandedRegistrationId === request.id} onClick={() => {
                    if (expandedRegistrationId === request.id) {
                      setExpandedRegistrationId(null)
                      setRegistrationReviewStage('')
                      setRegistrationDecisionModalOpen(false)
                      return
                    }
                    if (request.referenceAccessStatus === 'Paused') {
                      resumeRegistrationReview(request)
                      return
                    }
                    openRegistrationReview(request, getRegistrationReviewSteps()[0].key)
                  }}>{expandedRegistrationId === request.id ? 'Close review' : request.referenceAccessStatus === 'Paused' ? 'Resume review' : 'Review application'} <span aria-hidden="true">{expandedRegistrationId === request.id ? '−' : '→'}</span></button>
                </article>)}</div>
                : <div className="registration-list-empty"><strong>{pendingRegistrationCount ? 'No matching applications' : 'No pending applications'}</strong><span>{pendingRegistrationCount ? 'Try another name or request ID.' : 'New submissions will appear here.'}</span></div>}
            </section>
            {expandedRegistrationId && activeRegistrationReviewRequest && (() => {
                const request = activeRegistrationReviewRequest
                const reviewSteps = getRegistrationReviewSteps()
                const stages = reviewSteps
                const firstIncompleteStep = reviewSteps.find((step) => !request.reviewSteps?.[step.key])
                const currentStage = stages.some((step) => step.key === registrationReviewStage)
                  ? registrationReviewStage
                  : firstIncompleteStep?.key || stages[stages.length - 1]?.key
                const currentStageIndex = stages.findIndex((step) => step.key === currentStage)
                const currentStep = stages[currentStageIndex]
                const currentInformationSections = registrationReviewInformationSections.filter((section) => currentStep?.sectionKeys?.includes(section.key))
                const currentInformationGroups = currentInformationSections.map((section) => ({
                  section,
                  entries: section.fields.map(([field, label]) => {
                    const rawValue = request.data?.[field]
                    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '').trim()
                    return value ? { field, label, value } : null
                  }).filter(Boolean),
                }))
                const photosChecked = Boolean(request.reviewSteps?.photoReview)
                const isDecisionStage = currentStage === 'photoReview' && photosChecked
                const nextStage = stages[Math.min(currentStageIndex + 1, stages.length - 1)]
                return (
                  <div className="registration-review-modal-backdrop">
                  <section className="registration-review-inline" role="dialog" aria-modal="true" aria-labelledby="registration-review-title">
                      <header className="registration-review-inline-header">
                        <div><span className="section-number">APPLICATION REVIEW</span><h3 id="registration-review-title">{request.name}</h3><p className="registration-review-meta"><span>{request.id}</span><span className="registration-review-submitted">Submitted {request.submittedAt ? new Date(request.submittedAt).toLocaleDateString('en-PH') : 'date not recorded'}</span></p></div>
                        <button type="button" className="registration-review-inline-close" aria-label="Close review and return to pending applications" onClick={() => { setExpandedRegistrationId(null); setRegistrationReviewStage(''); setRegistrationActionError(''); setRegistrationDecisionModalOpen(false) }}>Close review</button>
                        <section className="registration-process-panel" aria-label="Registration review steps">
                          {getRegistrationReviewSteps().map((step, index) => {
                            const stepDescriptions = ['Personal details · Steps 1–3', 'Residency and ID · Steps 4–6', 'Proof and decision · Step 7']
                            const available = getRegistrationReviewSteps().slice(0, index).every((previousStep) => request.reviewSteps?.[previousStep.key])
                            const completed = Boolean(request.reviewSteps?.[step.key])
                            const current = registrationReviewStage === step.key
                            return <button
                              type="button"
                              className={`registration-process-step${current ? ' is-current' : ''}${completed ? ' is-complete' : ''}`}
                              key={step.key}
                              disabled={!available}
                              aria-current={current ? 'step' : undefined}
                              onClick={() => {
                                openRegistrationReview(request, step.key)
                                if (step.key === 'photoReview' && completed) setRegistrationDecisionModalOpen(true)
                              }}
                            >
                              <span><strong>{step.label}</strong><small>{completed ? 'Reviewed' : stepDescriptions[index]}</small></span>
                            </button>
                          })}
                        </section>
                      </header>
                      <div className="registration-review-inline-content">
                        {currentStep?.sectionKeys && <div className="registration-review-stage-body">
                          <header className="registration-current-step-heading"><span>FORM STEPS {currentStep.range}</span><h4>{currentStep.label}</h4><p>{currentStage === 'applicantInformation' ? 'Check sections 1–3: personal details, contact information, and current address.' : currentStage === 'residencyInformation' ? 'Check sections 4–6: residency history, household information, and identification.' : 'Check section 7 and verify the submitted proof of residence. Once confirmed, record your decision here.'}</p></header>
                          <div className="registration-review-information-groups">
                            {currentInformationGroups.map(({ section, entries }) => <section className="registration-review-information-card is-current-step" aria-label={section.title} key={section.key}>
                              <h4>{section.title}</h4>
                              {entries.length
                                ? <dl>{entries.map(({ field, label, value }) => <div key={field}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                                : <p className="registration-review-no-details">No information was submitted in this section.</p>}
                            </section>)}
                          </div>
                          {currentStage === 'residencyInformation' && <div className="registration-review-file-row">
                            <span>Valid ID upload</span>
                            {!request.backendRegistrationId && request.files?.validId
                              ? <RegistrationEvidencePreview evidence={request.files.validId} label="Valid ID" />
                              : <p>No ID image was attached to this request.</p>}
                          </div>}
                          {currentStage === 'photoReview' && <div className="registration-review-file-row">
                            <span>Proof of residence upload</span>
                            {!request.backendRegistrationId && request.files?.proofOfResidence
                              ? <RegistrationEvidencePreview evidence={request.files.proofOfResidence} label="Proof of residence" />
                              : <p>No proof-of-residence file was attached to this request.</p>}
                          </div>}
                          <footer className="registration-review-step-actions">
                            {currentStageIndex > 0 && !isDecisionStage && <button type="button" className="registration-step-back" onClick={() => setRegistrationReviewStage(stages[currentStageIndex - 1].key)}>Back</button>}
                            {!isDecisionStage && <button type="button" className="check-button" onClick={() => {
                              if (!request.reviewSteps?.[currentStage]) markRegistrationReviewStep(request, currentStage)
                              setRegistrationReviewStage(nextStage.key)
                              if (currentStage === 'photoReview') setRegistrationDecisionModalOpen(true)
                            }}>{request.reviewSteps?.[currentStage] ? `Continue to ${nextStage.label}` : currentStage === 'applicantInformation' ? 'Confirm steps 1–3' : currentStage === 'residencyInformation' ? 'Confirm steps 4–6' : 'Confirm step 7'}</button>}
                            {isDecisionStage && <button type="button" className="check-button registration-open-decision-button" onClick={() => setRegistrationDecisionModalOpen(true)}>Open final decision <span aria-hidden="true">→</span></button>}
                          </footer>
                        </div>}
                      </div>
                  </section>
                  </div>
                )
              })()}
            {registrationDecisionModalOpen && activeRegistrationReviewRequest && registrationReviewStage === 'photoReview' && activeRegistrationReviewRequest.reviewSteps?.photoReview && (() => {
              const request = activeRegistrationReviewRequest
              return <div className="registration-decision-modal-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget) setRegistrationDecisionModalOpen(false)
              }}>
                <section className="registration-decision-modal" role="dialog" aria-modal="true" aria-labelledby="registration-decision-title" onKeyDown={(event) => {
                  if (event.key === 'Escape') setRegistrationDecisionModalOpen(false)
                }}>
                  <header>
                    <div><span className="registration-decision-step-tag">STEP 3 · FINAL REVIEW</span><h3 id="registration-decision-title">Choose a decision</h3><p>Applicant · {request.name}</p></div>
                    <button type="button" className="registration-decision-modal-close" aria-label="Close final decision" onClick={() => setRegistrationDecisionModalOpen(false)}>×</button>
                  </header>
                  <p className="registration-decision-modal-copy">Select how to proceed with this application.</p>
                  {registrationActionError && <p className="registration-action-error" role="alert">{registrationActionError}</p>}
                  <label className="registration-decline-reason registration-admin-note">Reason / note for the applicant <span>(required to decline or pause)</span><textarea value={registrationAdminNote} onChange={(event) => setRegistrationAdminNote(event.target.value)} maxLength={1000} rows="3" placeholder="Example: The ID photo is unclear. Please upload a clearer image showing your full name and ID number." /></label>
                  <p className="registration-decision-note">Be specific and respectful. Mention what is missing or incorrect and what the applicant can do next, such as correcting a name mismatch or providing clearer proof of residence. This note is saved with a rejection or shown while the application is paused.</p>
                  <div className="registration-decision-modal-actions">
                    <button type="button" className="registration-decision-choice is-approve" disabled={processingRegistrationId === request.id} onClick={() => reviewRegistration(request, 'Approved')}><span aria-hidden="true">✓</span>{processingRegistrationId === request.id ? 'Saving…' : 'Approve'}</button>
                    <button type="button" className="registration-decision-choice is-decline" disabled={processingRegistrationId === request.id} onClick={() => reviewRegistration(request, 'Declined')}><span aria-hidden="true">×</span>Decline</button>
                    <button type="button" className="registration-decision-choice is-pause" disabled={processingRegistrationId === request.id} onClick={() => pauseRegistrationApplication(request)}><span aria-hidden="true">Ⅱ</span>Pause</button>
                  </div>
                </section>
              </div>
            })()}
            <section className="requests-panel registration-requests-panel registration-resident-directory">
              <div className="requests-heading"><div><span className="section-number">RESIDENT DIRECTORY</span><h2>Resident records</h2><p>Approved applicants appear here automatically with their generated resident code.</p></div><span className="request-notification">{adminResidents.length}</span></div>
              <TableSearch label="resident directory"><div className="table-scroll"><table className="admin-table"><thead><tr><th>Resident</th><th>Address</th><th>Resident code</th><th>Status</th><th>Information</th></tr></thead><tbody>{[...adminResidents].sort((first, second) => first.name.localeCompare(second.name)).map((resident) => <tr key={resident.id}>
                <td><strong>{resident.name}</strong></td><td>{resident.address || 'Address not recorded'}</td><td>{resident.code || 'Code not assigned'}</td>
                <td><span className={`compliance-status ${resident.recordStatus === 'inactive' ? 'declined' : 'approved'}`}>{resident.recordStatus === 'inactive' ? 'Inactive' : 'Active'}</span></td>
                <td><button type="button" className="resident-table-action" aria-label={`View information for ${resident.name}`} onClick={() => setRegistrationResidentViewCode(resident.code || resident.id)}>View information</button></td>
              </tr>)}
              {!adminResidents.length && <tr><td colSpan="5">No resident records yet. Approved applications will be added here.</td></tr>}
              </tbody></table></div></TableSearch>
            </section>
            {registrationResidentViewCode && (() => {
              const resident = adminResidents.find((candidate) => (
                candidate.code?.toLowerCase() === registrationResidentViewCode.toLowerCase()
                || candidate.id?.toLowerCase() === registrationResidentViewCode.toLowerCase()
              ))
              if (!resident) return null
              const residentCode = resident.code || resident.id
              const registration = registrationRequests.find((candidate) => (
                candidate.status === 'Approved'
                && candidate.assignedResidentCode?.toLowerCase() === residentCode?.toLowerCase()
              ))
              const detailSections = registrationReviewInformationSections.map((section) => ({
                ...section,
                entries: section.fields.filter(([field]) => field !== 'mobileNumber').map(([field, label]) => {
                  const rawValue = registration?.data?.[field]
                  const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '').trim()
                  return value ? { field, label, value } : null
                }).filter(Boolean),
              })).filter((section) => section.entries.length)
              return <div className="resident-profile-update-modal-backdrop" onMouseDown={(event) => {
                if (event.target === event.currentTarget) setRegistrationResidentViewCode('')
              }}>
                <section className="resident-profile-update-modal registration-resident-view-modal" role="dialog" aria-modal="true" aria-labelledby="registration-resident-view-title" onKeyDown={(event) => {
                  if (event.key === 'Escape') setRegistrationResidentViewCode('')
                }}>
                  <header>
                    <div><span className="section-number">RESIDENT RECORD</span><h2 id="registration-resident-view-title">{resident.name}</h2><p>{residentCode || 'Resident code not recorded'}</p></div>
                    <button type="button" aria-label="Close resident information" onClick={() => setRegistrationResidentViewCode('')}>×</button>
                  </header>
                  <div className="resident-profile-update-request-list registration-resident-view-content">
                    <article>
                      <h3>Resident account</h3>
                      <dl className="registration-data-grid">
                        <div><dt>Resident code</dt><dd>{residentCode || 'Not recorded'}</dd></div>
                        <div><dt>Account status</dt><dd>{resident.recordStatus === 'inactive' ? 'Inactive' : 'Active'}</dd></div>
                        <div><dt>Address</dt><dd>{resident.address || 'Not recorded'}</dd></div>
                        <div><dt>Date of birth</dt><dd>{resident.birthDate || resident.dateOfBirth || registration?.data?.birthDate || 'Not recorded'}</dd></div>
                        <div><dt>Email address</dt><dd>{resident.emailAddress || registration?.data?.emailAddress || 'Not recorded'}</dd></div>
                        <div><dt>Approved</dt><dd>{registration?.reviewedAt ? new Date(registration.reviewedAt).toLocaleString('en-PH') : 'Approval date not recorded'}</dd></div>
                        {registration && <div><dt>Application reference</dt><dd>{registration.id}</dd></div>}
                      </dl>
                    </article>
                    {detailSections.map((section) => <article key={section.key}>
                      <h3>{section.title}</h3>
                      <dl className="registration-data-grid">{section.entries.map(({ field, label, value }) => <div key={field}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                    </article>)}
                    {registration && (registration.files?.validId || registration.files?.proofOfResidence) && <article>
                      <h3>Submitted documents</h3>
                      {registration.files.validId && <div className="registration-review-file-row"><span>Valid ID</span><RegistrationEvidencePreview evidence={registration.files.validId} label="Valid ID" /></div>}
                      {registration.files.proofOfResidence && <div className="registration-review-file-row"><span>Proof of residence</span><RegistrationEvidencePreview evidence={registration.files.proofOfResidence} label="Proof of residence" /></div>}
                    </article>}
                    {!registration && <p className="resident-profile-note">No registration form is linked to this resident record.</p>}
                  </div>
                </section>
              </div>
            })()}
          </div>}
          {adminView === 'payments' && <section className="admin-payment-management-page">
            <PaymentWorkflowTabs activeView="payments" onSelect={setAdminView} />
            <div className="payment-dashboard-panels">
              <section className="payment-assessment-panel" aria-labelledby="payment-assessment-title">
                <header className="admin-panel-heading">
                  <div><span className="section-number">ACTION REQUIRED</span><h3 id="payment-assessment-title">Payment assessment</h3><p>Check the resident’s proof, then record the verified official receipt number.</p></div>
                  <span className="admin-panel-count">{paymentAssessmentRecords.length}</span>
                </header>
                <div className="payment-assessment-list">
                  {paymentAssessmentRecords.map((payment) => <article className={`payment-assessment-item${paymentReviewRequestId === payment.id ? ' is-expanded' : ''}`} key={payment.id}>
                    <div className="payment-assessment-summary">
                      <div className="payment-assessment-resident"><strong>{payment.resident}</strong><span>{payment.residentCode || 'Resident code not recorded'} · {payment.id}</span></div>
                      <div className="payment-assessment-request"><strong>{payment.documents?.join(' · ') || 'Document request'}</strong><span>{payment.requests.length} combined request{payment.requests.length === 1 ? '' : 's'}{payment.cancelledRequestCount > 0 ? ` (${payment.cancelledRequestCount} cancelled)` : ''} · {payment.paymentSubmittedAt ? new Date(payment.paymentSubmittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Submission time not recorded'}</span></div>
                      <span className="payment-action-needed"><i aria-hidden="true">!</i> Needs review</span>
                      <div className="payment-assessment-amount-wrap"><span>{payment.cancelledRequestCount > 0 ? 'After cancellation' : 'Amount submitted'}</span><strong className="payment-assessment-amount">₱{Number(payment.activeFeeAmount || 0).toFixed(2)}</strong></div>
                      <button type="button" className="payment-assessment-toggle" aria-expanded={paymentReviewRequestId === payment.id} onClick={() => { setPaymentReviewRequestId(paymentReviewRequestId === payment.id ? '' : payment.id); setPaymentOrNumber('') }}>{paymentReviewRequestId === payment.id ? 'Close' : 'Assess proof'}</button>
                    </div>
                    {paymentReviewRequestId === payment.id && <div className="payment-assessment-detail">
                      <dl>
                        <div><dt>Payment method</dt><dd>{payment.paymentMethod === 'walk-in' ? 'Walk-in at Barangay Hall' : payment.paymentMethod === 'gcash' ? 'GCash transfer' : payment.paymentMethod || 'Not provided'}</dd></div>
                        <div><dt>Resident reference</dt><dd>{payment.paymentProofOrNumber || 'Not provided'}</dd></div>
                        <div><dt>Combined requests</dt><dd>{payment.requests.length} combined request{payment.requests.length === 1 ? '' : 's'}{payment.cancelledRequestCount > 0 ? ` (${payment.cancelledRequestCount} cancelled)` : ''}</dd></div>
                        <div><dt>Original amount submitted</dt><dd>₱{Number(payment.feeAmount || 0).toFixed(2)}</dd></div>
                        {payment.cancelledRequestCount > 0 && <div><dt>Cancelled amount deducted</dt><dd>−₱{Number(payment.cancelledFeeAmount || 0).toFixed(2)}</dd></div>}
                        <div><dt>Amount for active requests</dt><dd>₱{Number(payment.activeFeeAmount || 0).toFixed(2)}</dd></div>
                      </dl>
                      {payment.paymentProof?.dataUrl
                        ? <a className="payment-proof-preview" href={payment.paymentProof.dataUrl} target="_blank" rel="noreferrer"><img src={payment.paymentProof.dataUrl} alt={`Payment receipt for ${payment.id}`} /><span>{payment.paymentProof.fileName || 'View payment proof'}</span></a>
                        : <p className="payment-assessment-no-proof">No image uploaded. Verify the resident’s reference number against the GCash transaction.</p>}
                      <form onSubmit={(event) => { event.preventDefault(); markRequestPaymentPaid(payment) }}>
                        <label htmlFor={`payment-assessment-or-${payment.id}`}>Verified official receipt / transaction number<input id={`payment-assessment-or-${payment.id}`} value={paymentOrNumber} onChange={(event) => setPaymentOrNumber(event.target.value)} placeholder="Enter the verified reference" required /></label>
                        <button type="submit" className="payment-confirm-button">Confirm payment</button>
                      </form>
                    </div>}
                  </article>)}
                  {!paymentAssessmentRecords.length && <div className="payment-assessment-empty"><span aria-hidden="true">✓</span><strong>All caught up</strong><p>No payment proofs are waiting for assessment.</p></div>}
                </div>
              </section>
              <section className="payment-recipients-panel" aria-labelledby="payment-recipients-title">
                <header className="admin-panel-heading">
                  <div><span className="section-number">RESIDENT PAYMENT DETAILS</span><h3 id="payment-recipients-title">GCash recipient accounts</h3><p>These details appear in residents’ payment instructions.</p></div>
                  <button type="button" className="payment-add-recipient" onClick={addGcashRecipient} disabled={Boolean(gcashRecipientEditor)}><span aria-hidden="true">+</span> Add</button>
                </header>
                <div className="payment-recipient-grid">
                  {gcashRecipients.map((recipient, index) => {
                    const isEditing = gcashRecipientEditor?.mode === 'edit'
                      && gcashRecipientEditor.recipient.id === recipient.id
                    return <article className="payment-recipient-card" key={recipient.id}>
                      <div className="payment-recipient-card-heading">
                        <span>Account {index + 1}</span>
                        {!isEditing && <div className="payment-recipient-card-actions">
                          <button type="button" className="payment-edit-recipient" onClick={() => editGcashRecipient(recipient)} disabled={Boolean(gcashRecipientEditor)}>Edit</button>
                          <button type="button" className="payment-remove-recipient" onClick={() => removeGcashRecipient(recipient.id)} aria-label={`Remove recipient ${index + 1}`} disabled={Boolean(gcashRecipientEditor)}>Remove</button>
                        </div>}
                      </div>
                      {isEditing
                        ? <form className="payment-recipient-editor" onSubmit={saveGcashRecipient}>
                          <label htmlFor={`gcash-recipient-name-${recipient.id}`}>Account name<input id={`gcash-recipient-name-${recipient.id}`} value={gcashRecipientEditor.recipient.displayName} onChange={(event) => updateGcashRecipientDraft('displayName', event.target.value)} maxLength={100} placeholder="Name registered with GCash" required /></label>
                          <label htmlFor={`gcash-recipient-number-${recipient.id}`}>GCash mobile number<input id={`gcash-recipient-number-${recipient.id}`} type="tel" value={gcashRecipientEditor.recipient.mobileNumber} onChange={(event) => updateGcashRecipientDraft('mobileNumber', event.target.value)} maxLength={20} placeholder="09XX XXX XXXX" required /></label>
                          <label htmlFor={`gcash-recipient-qr-${recipient.id}`}>GCash QR image<input id={`gcash-recipient-qr-${recipient.id}`} type="file" accept="image/png,image/jpeg,image/webp" onChange={handleGcashQrUpload} disabled={gcashQrUploadLoading} /><small>Optional · PNG, JPEG, or WebP up to 700 KB</small></label>
                          {gcashQrUploadLoading && <small role="status">Loading QR image…</small>}
                          {gcashRecipientEditor.recipient.qrImage?.dataUrl && <div className="payment-recipient-qr-preview">
                            <img src={gcashRecipientEditor.recipient.qrImage.dataUrl} alt={`GCash QR for ${gcashRecipientEditor.recipient.displayName || 'this recipient'}`} />
                            <button type="button" className="payment-remove-recipient" onClick={() => updateGcashRecipientDraft('qrImage', null)} disabled={gcashQrUploadLoading}>Remove QR</button>
                          </div>}
                          {gcashRecipientError && <p className="payment-recipient-error" role="alert">{gcashRecipientError}</p>}
                          <div className="payment-recipient-editor-actions"><button type="submit" className="payment-save-recipient" disabled={gcashQrUploadLoading}>Save account</button><button type="button" className="payment-cancel-recipient" onClick={cancelGcashRecipientEdit} disabled={gcashQrUploadLoading}>Cancel</button></div>
                        </form>
                        : <div className="payment-recipient-readonly">
                          <div><span>Account name</span><strong>{recipient.displayName || 'Name not set'}</strong></div>
                          <div><span>GCash mobile number</span><strong>{recipient.mobileNumber || 'Number not set'}</strong></div>
                          {recipient.qrImage?.dataUrl && <img className="payment-recipient-qr-thumbnail" src={recipient.qrImage.dataUrl} alt={`GCash QR for ${recipient.displayName}`} />}
                        </div>}
                    </article>
                  })}
                  {gcashRecipientEditor?.mode === 'add' && <article className="payment-recipient-card">
                    <div className="payment-recipient-card-heading"><span>New account</span></div>
                    <form className="payment-recipient-editor" onSubmit={saveGcashRecipient}>
                      <label htmlFor="gcash-recipient-name-new">Account name<input id="gcash-recipient-name-new" value={gcashRecipientEditor.recipient.displayName} onChange={(event) => updateGcashRecipientDraft('displayName', event.target.value)} maxLength={100} placeholder="Name registered with GCash" required /></label>
                      <label htmlFor="gcash-recipient-number-new">GCash mobile number<input id="gcash-recipient-number-new" type="tel" value={gcashRecipientEditor.recipient.mobileNumber} onChange={(event) => updateGcashRecipientDraft('mobileNumber', event.target.value)} maxLength={20} placeholder="09XX XXX XXXX" required /></label>
                      <label htmlFor="gcash-recipient-qr-new">GCash QR image<input id="gcash-recipient-qr-new" type="file" accept="image/png,image/jpeg,image/webp" onChange={handleGcashQrUpload} disabled={gcashQrUploadLoading} /><small>Optional · PNG, JPEG, or WebP up to 700 KB</small></label>
                      {gcashQrUploadLoading && <small role="status">Loading QR image…</small>}
                      {gcashRecipientEditor.recipient.qrImage?.dataUrl && <div className="payment-recipient-qr-preview">
                        <img src={gcashRecipientEditor.recipient.qrImage.dataUrl} alt={`GCash QR for ${gcashRecipientEditor.recipient.displayName || 'this recipient'}`} />
                        <button type="button" className="payment-remove-recipient" onClick={() => updateGcashRecipientDraft('qrImage', null)} disabled={gcashQrUploadLoading}>Remove QR</button>
                      </div>}
                      {gcashRecipientError && <p className="payment-recipient-error" role="alert">{gcashRecipientError}</p>}
                      <div className="payment-recipient-editor-actions"><button type="submit" className="payment-save-recipient" disabled={gcashQrUploadLoading}>Save account</button><button type="button" className="payment-cancel-recipient" onClick={cancelGcashRecipientEdit} disabled={gcashQrUploadLoading}>Cancel</button></div>
                    </form>
                  </article>}
                  {!gcashRecipients.length && <p className="payment-recipient-empty">No GCash recipient is configured. Add a verified account before asking residents to pay.</p>}
                </div>
                <p className="payment-recipient-note" role="status">Saved account details appear in residents’ payment instructions.</p>
              </section>
            </div>
            <section className="payment-history-section" aria-labelledby="payment-history-title">
              <header className="admin-panel-heading">
                <div><span className="section-number">VERIFIED PAYMENTS</span><h3 id="payment-history-title">Payment history</h3><p>Verified payments remain here even when a request is later cancelled or refunded.</p></div>
                <span className="admin-panel-count">{paymentHistoryRecords.length} records</span>
              </header>
              <TableSearch label="payment history"><div className="table-scroll"><table className="admin-table payment-history-table"><thead><tr><th>Resident</th><th>Resident code</th><th>Request</th><th>Payment submitted</th><th>Amount</th><th>Payment reference</th><th>Status</th></tr></thead><tbody>
                {paymentHistoryRecords.map((payment) => {
                  const cancelledRequests = payment.requests.filter((request) => request.status === 'Cancelled')
                  const refundedAmount = payment.requests
                    .filter((request) => request.refundStatus === 'Refunded')
                    .reduce((total, request) => total + Number(request.feeAmount || 0), 0)
                  const paymentOutcome = [
                    cancelledRequests.length ? `${cancelledRequests.length} of ${payment.requests.length} requests cancelled` : '',
                    refundedAmount > 0 ? `Refunded ₱${refundedAmount.toFixed(2)} · net ₱${Math.max(0, Number(payment.feeAmount || 0) - refundedAmount).toFixed(2)}` : '',
                  ].filter(Boolean).join(' · ')
                  return <tr key={payment.groupKey}>
                    <td><strong>{payment.resident}</strong></td>
                    <td>{payment.residentCode || 'Not recorded'}</td>
                    <td className="payment-history-request-cell"><strong>{payment.documents?.join(' · ') || 'Document request'}</strong><small>{payment.requests.length > 1 ? `${payment.requests.length} requests · ` : ''}{payment.id}</small></td>
                    <td>{payment.paymentSubmittedAt ? new Date(payment.paymentSubmittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded'}</td>
                    <td>₱{Number(payment.feeAmount || 0).toFixed(2)}</td>
                    <td>{payment.paymentOrNumber || payment.paymentProofOrNumber || 'No reference recorded'}</td>
                    <td className="payment-history-status-cell"><span className={`compliance-status ${String(payment.paymentStatus || 'Unpaid').toLowerCase().replace(/\s+/g, '-')}`}>{payment.paymentStatus || 'Unpaid'}</span>{paymentOutcome && <small>{paymentOutcome}</small>}</td>
                  </tr>
                })}
                {!paymentHistoryRecords.length && <tr><td colSpan="7">No payments have been verified yet.</td></tr>}
              </tbody></table></div></TableSearch>
            </section>
          </section>}
          {adminView === 'refunds' && <section className="refund-management-page">
            <PaymentWorkflowTabs activeView="refunds" onSelect={setAdminView} />
            <section className="refund-process-panel" aria-label="Refund process">
              <span className="refund-process-step"><b>01</b><span><strong>Confirm cancellation</strong><small>Check the request and original payment.</small></span></span>
              <span className="refund-process-step"><b>02</b><span><strong>Return payment manually</strong><small>Send to the resident’s confirmed GCash number.</small></span></span>
              <span className="refund-process-step"><b>03</b><span><strong>Save proof or reference</strong><small>Record evidence for the resident and payment history.</small></span></span>
            </section>
            <section className="refund-requests-panel" aria-labelledby="refund-requests-title">
              <header className="admin-panel-heading">
                <div><span className="section-number">REFUND QUEUE</span><h3 id="refund-requests-title">Cancelled requests</h3><p>Refunds apply to the cancelled request’s fee only; other requests paid with the same proof remain separate.</p></div>
                <span className="admin-panel-count">{cancelledPaymentRequests.length}</span>
              </header>
              <div className="refund-request-list">
                {cancelledPaymentRequests.map((request) => {
                  const sharedPayment = adminPaymentRecords.find((payment) => payment.requestIds.includes(request.id))
                  const relatedRequests = sharedPayment?.requests || [request]
                  const sharedPaidAmount = Number(sharedPayment?.feeAmount ?? request.feeAmount ?? 0)
                  const cancelledCount = relatedRequests.filter((relatedRequest) => relatedRequest.status === 'Cancelled').length
                  return <article className={`refund-request-card${refundRequestId === request.id ? ' is-expanded' : ''}`} key={request.id}>
                  <div className="refund-request-summary">
                    <div className="refund-request-resident"><strong>{request.resident}</strong><span>{request.residentCode || 'Resident code not recorded'} · {request.id}</span></div>
                    <div className="refund-request-document"><strong>{request.documents?.join(' · ') || 'Document request'}</strong><span>Cancelled {request.cancelledAt ? new Date(request.cancelledAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'date not recorded'}</span></div>
                    <div className="refund-request-amount"><span>Cancelled request fee</span><strong>₱{Number(request.feeAmount || 0).toFixed(2)}</strong></div>
                    <span className={`refund-status-pill ${request.refundStatus === 'Refunded' ? 'is-complete' : ''}`}>{request.paymentStatus === 'Pending verification' ? 'Verify payment first' : request.refundStatus === 'Refunded' ? 'Refund recorded' : 'Needs follow-up'}</span>
                    <button type="button" className="refund-request-toggle" aria-expanded={refundRequestId === request.id} onClick={() => {
                      const opening = refundRequestId !== request.id
                      const contactNumber = getPaymentResidentContactNumber(request)
                      setRefundRequestId(opening ? request.id : '')
                      setRefundDestinationNumber(request.refundDestinationNumber || (contactNumber !== 'Not provided' ? contactNumber : ''))
                      setRefundTransactionNumber(request.refundTransactionNumber || '')
                      setRefundProof(null)
                      setRefundNote(request.refundNote || '')
                      setRefundError('')
                      setRefundProofError('')
                    }}>{refundRequestId === request.id ? 'Close details' : request.paymentStatus === 'Pending verification' ? 'Assess payment' : request.refundStatus === 'Refunded' ? 'View evidence' : 'Process refund'}</button>
                  </div>
                  {relatedRequests.length > 1 && <div className="refund-request-combined-note"><strong>{relatedRequests.length} combined requests ({cancelledCount} cancelled)</strong><span>Shared payment proof · ₱{sharedPaidAmount.toFixed(2)} total</span></div>}
                  {refundRequestId === request.id && <div className="refund-request-detail">
                    <dl className="refund-resident-details">
                      <div><dt>Resident</dt><dd>{request.resident}</dd></div>
                      <div><dt>Resident code</dt><dd>{request.residentCode || 'Not recorded'}</dd></div>
                      <div><dt>Contact on file</dt><dd>{getPaymentResidentContactNumber(request)}</dd></div>
                      <div><dt>Cancelled request fee</dt><dd>₱{Number(request.feeAmount || 0).toFixed(2)}</dd></div>
                      {relatedRequests.length > 1 && <div><dt>Shared payment total</dt><dd>₱{sharedPaidAmount.toFixed(2)} · {relatedRequests.length} combined requests ({cancelledCount} cancelled)</dd></div>}
                    </dl>
                    {relatedRequests.length > 1 && <p className="refund-shared-payment-note">One payment proof covers {relatedRequests.map((relatedRequest) => `${relatedRequest.documents?.join(' · ') || 'Document request'} (${relatedRequest.status})`).join('; ')}. Only the cancelled request’s ₱{Number(request.feeAmount || 0).toFixed(2)} fee is eligible for refund; each other request remains separate and follows its own status.</p>}
                    {(request.paymentProof?.dataUrl || request.paymentProofOrNumber) && <div className="refund-original-payment-proof">
                      <strong>Original payment proof {relatedRequests.length > 1 ? '(shared payment evidence)' : ''}</strong>
                      {request.paymentProof?.dataUrl
                        ? <a className="payment-proof-preview" href={request.paymentProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.paymentProof.dataUrl} alt={`Original payment proof for ${request.id}`} /><span>{request.paymentProof.fileName || 'View original payment proof'}</span></a>
                        : <span>Resident reference: {request.paymentProofOrNumber}</span>}
                    </div>}
                    {request.paymentStatus === 'Pending verification' ? <div className="refund-pending-payment">
                      <p><strong>Payment proof needs assessment before a refund can be processed.</strong> If the submitted proof confirms payment, mark it as paid. The request will then remain here for refund follow-up.</p>
                      <dl><div><dt>Resident reference</dt><dd>{request.paymentProofOrNumber || 'Not provided'}</dd></div><div><dt>Payment submitted</dt><dd>{request.paymentSubmittedAt ? new Date(request.paymentSubmittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded'}</dd></div></dl>
                      <form onSubmit={(event) => {
                        event.preventDefault()
                        const payment = adminPaymentRecords.find((record) => record.requestIds.includes(request.id))
                        if (!paymentOrNumber.trim()) return
                        markRequestPaymentPaid(payment || { ...request, requestIds: [request.id] })
                      }}>
                        <label>Verified payment / official receipt number<input value={paymentOrNumber} onChange={(event) => setPaymentOrNumber(event.target.value)} placeholder="Enter the verified reference" required /></label>
                        <button type="submit" className="payment-confirm-button">Confirm payment received</button>
                      </form>
                    </div> : request.refundStatus === 'Refunded' ? <div className="refund-recorded-evidence">
                      <p><strong>Refund destination:</strong> {request.refundDestinationNumber || 'Not recorded'}</p>
                      <p><strong>Transaction reference:</strong> {request.refundTransactionNumber || 'Not provided; proof image attached'}</p>
                      <p><strong>Recorded:</strong> {request.refundedAt ? new Date(request.refundedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</p>
                      {request.refundNote && <p><strong>Notes:</strong> {request.refundNote}</p>}
                      {request.refundProof?.dataUrl && <a className="payment-proof-preview" href={request.refundProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.refundProof.dataUrl} alt={`Refund proof for ${request.id}`} /><span>{request.refundProof.fileName || 'View refund proof'}</span></a>}
                    </div> : <form className="refund-process-form" onSubmit={(event) => recordManualRefund(event, request)}>
                      <p className="refund-manual-warning">This app does not transfer money. Complete the refund through GCash first. A proof image or transaction reference is required to mark the refund as recorded.</p>
                      <div className="refund-form-fields">
                        <label>Resident’s GCash mobile number<input type="tel" value={refundDestinationNumber} onChange={(event) => setRefundDestinationNumber(event.target.value)} placeholder="Confirm number with resident" required /></label>
                        <label>GCash refund transaction reference <span>(optional if proof image is attached)</span><input value={refundTransactionNumber} onChange={(event) => setRefundTransactionNumber(event.target.value)} placeholder="Enter the completed refund reference" /></label>
                        <label className="refund-proof-upload">Refund proof image <span>(optional if reference is entered)</span><input type="file" accept="image/*" onChange={(event) => uploadRefundProof(event.target.files?.[0])} /><small>{refundProofLoading ? 'Preparing proof image…' : refundProof?.fileName || 'Upload a screenshot or receipt'}</small></label>
                        <label className="refund-note-field">Additional details<textarea value={refundNote} onChange={(event) => setRefundNote(event.target.value)} rows="2" maxLength="400" placeholder="Optional notes for the refund record" /></label>
                      </div>
                      {refundProofError && <p className="community-update-error" role="alert">{refundProofError}</p>}
                      {refundProof && <a className="payment-proof-preview" href={refundProof.dataUrl} target="_blank" rel="noreferrer"><img src={refundProof.dataUrl} alt="Selected refund proof preview" /><span>{refundProof.fileName}</span></a>}
                      {refundError && <p className="community-update-error" role="alert">{refundError}</p>}
                      <div className="refund-form-actions"><button type="submit" className="payment-confirm-button" disabled={refundProofLoading}>Record completed refund</button><button type="button" className="community-cancel-button" onClick={() => { setRefundRequestId(''); setRefundError(''); setRefundProofError('') }}>Cancel</button></div>
                    </form>}
                  </div>}
                </article>
                })}
                {!cancelledPaymentRequests.length && <div className="refund-request-empty"><span aria-hidden="true">✓</span><strong>No cancelled requests need payment follow-up</strong><p>Cancelled requests with submitted or verified payments will appear here.</p></div>}
              </div>
            </section>
          </section>}
          {(adminView === 'residents' || adminView === 'archivedResidents') && <section className="requests-panel resident-records-panel green-startup-workspace">
            <div className="requests-heading"><div><span className="section-number">RESIDENT DIRECTORY</span><h2>Resident records</h2><p>Manage current residents and review rejected registration applications.</p></div><span className="request-notification">{adminResidents.length} current</span></div>
            {residentAccountMessage && !residentProfileUpdateResidentCode && <p className="resident-account-message" role="status">{residentAccountMessage}</p>}
            <div className="resident-record-tabs" role="group" aria-label="Resident record categories">
              <button type="button" aria-pressed={residentRecordsTab === 'active'} className={residentRecordsTab === 'active' ? 'active' : ''} onClick={() => setResidentRecordsTab('active')}>Current residents <span>{adminResidents.length}</span></button>
              <button type="button" aria-pressed={residentRecordsTab === 'recovery'} className={residentRecordsTab === 'recovery' ? 'active' : ''} onClick={() => { setResidentRecordsTab('recovery'); setAdminRecoveryMessage('') }}>Resident code recovery <span>{pendingRecoveryRequestCount}</span></button>
              <button type="button" aria-pressed={residentRecordsTab === 'rejected'} className={residentRecordsTab === 'rejected' ? 'active' : ''} onClick={() => setResidentRecordsTab('rejected')}>Rejected registrations <span>{declinedRegistrationRequests.length}</span></button>
            </div>
            {residentRecordsTab !== 'recovery' && <label className="resident-record-search"><span className="sr-only">Search resident records</span><input type="search" value={residentRecordsSearch} onChange={(event) => { setResidentRecordsSearch(event.target.value); setHighlightedResidentId('') }} placeholder={residentRecordsTab === 'rejected' ? 'Search applicant, address, request ID, or resident code' : 'Search by name, address, resident code, or request ID'} /></label>}
            {residentRecordsTab === 'active' ? <section className="resident-record-tab-panel">
              <button type="button" className="resident-add-form-toggle" aria-expanded={residentFormOpen || Boolean(editingResidentId)} disabled={Boolean(editingResidentId)} onClick={() => { setResidentFormOpen((isOpen) => !isOpen); setResidentFormError('') }}>
                <span aria-hidden="true">{residentFormOpen || editingResidentId ? '−' : '+'}</span>{editingResidentId ? 'Editing resident' : residentFormOpen ? 'Hide resident form' : 'Add resident'}
              </button>
              {(residentFormOpen || editingResidentId) && <form className="resident-record-form" onSubmit={saveResident}>
                <div className="resident-name-fields">
                  <label htmlFor="admin-resident-first-name"><span className="resident-field-label">First name</span><input id="admin-resident-first-name" value={residentForm.firstName} onChange={(event) => setResidentForm({ ...residentForm, firstName: event.target.value })} placeholder="Given name(s)" autoComplete="given-name" required /></label>
                  <label htmlFor="admin-resident-middle-name"><span className="resident-field-label">Middle name <span className="resident-field-optional">(optional)</span></span><input id="admin-resident-middle-name" value={residentForm.middleName} onChange={(event) => setResidentForm({ ...residentForm, middleName: event.target.value })} placeholder="Middle name(s)" autoComplete="additional-name" /></label>
                  <label htmlFor="admin-resident-last-name"><span className="resident-field-label">Last name</span><input id="admin-resident-last-name" value={residentForm.lastName} onChange={(event) => setResidentForm({ ...residentForm, lastName: event.target.value })} placeholder="Family name(s)" autoComplete="family-name" required /></label>
                  <label htmlFor="admin-resident-suffix"><span className="resident-field-label">Suffix <span className="resident-field-optional">(optional)</span></span><input id="admin-resident-suffix" value={residentForm.suffix} onChange={(event) => setResidentForm({ ...residentForm, suffix: event.target.value })} placeholder="Jr., Sr., III" autoComplete="honorific-suffix" /></label>
                </div>
                <p className="resident-name-help">Separate multiple names with spaces (for example, “Mary Jane”). Review names split from existing records before saving.</p>
                <div className="resident-account-contact-fields">
                  <label htmlFor="admin-resident-address">Address<input id="admin-resident-address" value={residentForm.address} onChange={(event) => setResidentForm({ ...residentForm, address: event.target.value })} required /></label>
                  <label htmlFor="admin-resident-birth-date">Date of birth<input id="admin-resident-birth-date" type="date" value={residentForm.birthDate} onChange={(event) => setResidentForm({ ...residentForm, birthDate: event.target.value })} /></label>
                  <label htmlFor="admin-resident-email">Email address<input id="admin-resident-email" type="email" value={residentForm.emailAddress} onChange={(event) => setResidentForm({ ...residentForm, emailAddress: event.target.value })} /></label>
                </div>
                <p className="resident-name-help">Recovery notifications are sent to the email address saved on this record.</p>
                <div className="resident-form-actions">
                  {editingResidentId && <div className="resident-generated-code"><span>Resident code</span><strong>{residentForm.code}</strong></div>}
                  <div className="resident-form-buttons">
                    {editingResidentId && <button type="button" className="community-cancel-button" onClick={() => { setResidentForm({ firstName: '', middleName: '', lastName: '', suffix: '', address: '', birthDate: '', contactNumber: '', emailAddress: '', code: '' }); setEditingResidentId(null); setResidentFormOpen(false) }}>Cancel</button>}
                    <button type="submit" className="check-button">{editingResidentId ? 'Save changes' : 'Add resident'}</button>
                  </div>
                </div>
              </form>}
              {residentFormError && <p className="community-update-error" role="alert">{residentFormError}</p>}
              <p className="resident-record-result-count" aria-live="polite">Showing {filteredAdminResidents.length} of {adminResidents.length} current residents</p>
              <div className="table-scroll"><table className="admin-table resident-records-table"><thead><tr><th>Name</th><th>Address</th><th>Email address</th><th>Resident code</th><th>Account</th><th>Actions</th></tr></thead><tbody>{filteredAdminResidents.map((resident) => {
                const profileRequests = residentProfileUpdateRequests.filter((request) => request.residentCode?.toLowerCase() === resident.code.toLowerCase())
                const pendingProfileRequests = profileRequests.filter((request) => request.status === 'Pending').length
                const isRecoveryNameMatch = resident.id === highlightedResidentId
                const residentAddressLabel = getResidentRecordAddressLabel(resident, registrationRequests)
                return <tr className={isRecoveryNameMatch ? 'recovery-resident-match' : ''} key={resident.id}>
                  <td><strong>{resident.name}</strong>{isRecoveryNameMatch && <small className="recovery-resident-match-label">Closest name match for recovery request</small>}</td>
                  <td>{residentAddressLabel}</td>
                  <td>{resident.emailAddress || 'Not recorded'}</td>
                  <td>{resident.code}</td>
                  <td><span className={`compliance-status ${resident.recordStatus === 'inactive' ? 'declined' : 'approved'}`}>{resident.recordStatus === 'inactive' ? 'Inactive' : 'Active'}</span></td>
                  <td><div className="table-actions">
                    <button type="button" onClick={() => editResident(resident)}>Edit</button>
                    <button type="button" className={resident.recordStatus === 'inactive' ? '' : 'table-delete'} onClick={() => toggleResidentRecordStatus(resident)}>{resident.recordStatus === 'inactive' ? 'Reactivate' : 'Deactivate'}</button>
                    {profileRequests.length > 0 && <button type="button" className="resident-profile-update-icon" aria-label={`Open ${profileRequests.length} profile update request${profileRequests.length === 1 ? '' : 's'} for ${resident.name}`} title="Review profile update requests" onClick={() => { setResidentProfileUpdateResidentCode(resident.code); setProfileUpdateError(''); setResidentAccountMessage('') }}><span aria-hidden="true">✎</span>{pendingProfileRequests > 0 && <small>{pendingProfileRequests}</small>}</button>}
                  </div></td>
                </tr>
              })}{filteredAdminResidents.length === 0 && <tr><td colSpan="6">{adminResidents.length ? 'No current residents match your search.' : 'No resident records yet.'}</td></tr>}</tbody></table></div>
            </section> : residentRecordsTab === 'recovery' ? <section className="resident-record-tab-panel resident-code-recovery-tab">
              <div className="requests-heading"><div><span className="section-number">EXISTING RESIDENT ACCESS</span><h3>Resident code recovery requests</h3><p>Verify against an existing resident record. Recovery never creates a new resident account.</p></div><span className="request-notification">{pendingRecoveryRequestCount} pending</span></div>
              {adminRecoveryMessage && <p className="recovery-admin-message" role="status">{adminRecoveryMessage}</p>}
              {!officialBackendToken && <p className="recovery-admin-warning">Admin local sign-in is enough to review requests, but sending a resident code requires an authorized backend admin login and a running resident database service.</p>}
              {recoveryDeliveryRequest && <div className="recovery-delivery-backdrop">
                <section className="recovery-delivery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-delivery-title" aria-describedby="recovery-delivery-note">
                  <header className="recovery-delivery-header">
                    <div><span className="section-number">SECURE ACCOUNT RECOVERY</span><h3 id="recovery-delivery-title">Generate a new resident code</h3></div>
                    <button type="button" className="resident-code-recovery-close" aria-label="Close delivery options" disabled={isSendingRecoveryCode} onClick={() => setRecoveryDeliveryRequest(null)}>×</button>
                  </header>
                  <div className="recovery-code-rotation-notice" id="recovery-delivery-note">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4.8 9A7.5 7.5 0 0 1 18 6.8L20 9M4 17v-5h5m10.2 3A7.5 7.5 0 0 1 6 17.2L4 15" /></svg>
                    <p><strong>{recoveryDeliveryRequest.fullName}'s current code will be replaced.</strong><span>A new code will be sent only to the Gmail saved on the verified resident record. Resident Records and linked requests will update after email delivery succeeds.</span></p>
                  </div>
                  <div className="recovery-delivery-recipient"><span>Resident's saved Gmail address</span><strong>{recoveryDeliveryDetails?.savedEmail || 'No email is saved on this resident record.'}</strong></div>
                  <div className="recovery-delivery-options">
                    <button type="button" autoFocus disabled={isSendingRecoveryCode || !officialBackendToken || !recoveryDeliveryDetails?.savedEmail} onClick={() => (
                      recoveryDeliveryMode === 'verify'
                        ? verifyRecoveryResidentWithEmail(recoveryDeliveryRequest)
                        : sendRecoveredResidentCode(recoveryDeliveryRequest)
                    )}>
                      <strong>Generate and email new code</strong><span>The previous code will be replaced; the new code goes only to the saved address above.</span>
                    </button>
                  </div>
                  {adminRecoveryMessage
                    ? <p className="recovery-delivery-error" role="alert">{adminRecoveryMessage}</p>
                    : <p className="recovery-delivery-status" role="status" aria-live="polite">{isSendingRecoveryCode
                      ? 'Generating the replacement code and sending it securely…'
                      : !officialBackendToken
                        ? 'Review the resident details here. Sending requires an authorized backend admin session; sign in again after that account is configured.'
                        : recoveryDeliveryDetails?.savedEmail
                          ? 'A new code will be created only after you confirm. The existing code remains active if the email cannot be sent.'
                        : 'No Gmail address is saved. Update the resident record before generating a new code.'}</p>}
                  <button type="button" className="community-cancel-button" disabled={isSendingRecoveryCode} onClick={() => setRecoveryDeliveryRequest(null)}>Cancel</button>
                </section>
              </div>}
              <TableSearch label="resident code recovery requests"><div className="table-scroll"><table className="admin-table"><thead><tr><th>Request</th><th>Resident</th><th>Birthday</th><th>Email address</th><th>Status</th><th>Action</th></tr></thead><tbody>
                {residentCodeRecoveryRequests.map((request) => {
                  const closestResident = getClosestResidentRecord(request.fullName, adminResidents)
                  const comparisonResident = adminResidents.find((resident) => resident.id === request.matchedResidentId) || closestResident
                  const comparisonRegistration = comparisonResident && registrationRequests.find((candidate) => (
                    candidate.status === 'Approved'
                    && candidate.assignedResidentCode?.toLowerCase() === comparisonResident.code?.toLowerCase()
                  ))
                  const savedBirthDate = comparisonResident?.dateOfBirth || comparisonResident?.birthDate || comparisonRegistration?.data?.birthDate || ''
                  const savedEmail = comparisonResident?.emailAddress || comparisonRegistration?.data?.emailAddress || ''
                  const compareRecoveryValue = (submitted, stored, normalize = (value) => String(value || '').trim().toLowerCase()) => {
                    if (!stored) return 'Not recorded'
                    return normalize(submitted) === normalize(stored) ? 'Matches' : 'Does not match'
                  }
                  return <Fragment key={request.id}>
                  <tr>
                    <td>{request.id}</td><td>{request.fullName}</td><td>{request.birthDate}</td><td>{request.emailAddress || 'Not provided'}</td>
                    <td><span className={`compliance-status ${request.status.toLowerCase().replace(/\s+/g, '-')}`}>{request.status}</span></td>
                    <td><button type="button" className="open-request" onClick={() => { setExpandedRecoveryRequestId(expandedRecoveryRequestId === request.id ? null : request.id); setAdminRecoveryMessage('') }} aria-expanded={expandedRecoveryRequestId === request.id}>{expandedRecoveryRequestId === request.id ? 'Close review' : 'Review'}</button></td>
                  </tr>
                  {expandedRecoveryRequestId === request.id && <tr className="registration-detail-row"><td colSpan="6">
                    <div className="registration-request-detail recovery-request-detail">
                      <h3>Recovery assistance details</h3>
                      <dl className="registration-data-grid">
                        <div><dt>Resident name</dt><dd>{request.fullName}</dd></div>
                        <div><dt>Date of birth</dt><dd>{request.birthDate}</dd></div>
                        <div><dt>Email address provided</dt><dd>{request.emailAddress || 'Not provided'}</dd></div>
                        <div><dt>Address</dt><dd>{request.address}</dd></div>
                        <div><dt>Reason for assistance</dt><dd>{request.reason}</dd></div>
                        <div><dt>Submitted</dt><dd>{new Date(request.submittedAt).toLocaleString()}</dd></div>
                        {request.matchedResidentCode && <div><dt>Verified existing record</dt><dd>{adminResidents.find((resident) => resident.id === request.matchedResidentId)?.name || request.fullName} · {request.matchedResidentCode}</dd></div>}
                        {request.codeSentAt && <div><dt>Replacement code emailed</dt><dd>{new Date(request.codeSentAt).toLocaleString()}</dd></div>}
                      </dl>
                      {comparisonResident ? <section className="recovery-record-comparison" aria-label="Compare recovery form with resident record">
                        <div><h4>{request.matchedResidentId ? 'Verified resident record' : 'Closest resident record for comparison'}</h4><p>Compare the submitted information with the saved record before verifying. The closest name is only a suggestion; confirm identity from the details.</p></div>
                        <TableSearch label="recovery record comparison"><div className="table-scroll"><table className="admin-table"><thead><tr><th>Information</th><th>Submitted in recovery form</th><th>Saved resident record</th><th>Comparison</th></tr></thead><tbody>
                          {[
                            ['Full name', request.fullName, comparisonResident.name, (value) => normalizeRecoveryIdentity(value)],
                            ['Date of birth', request.birthDate, savedBirthDate, (value) => normalizeRecoveryDate(value)],
                            ['Email address', request.emailAddress, savedEmail,
                              (value) => normalizeRecoveryEmail(value)],
                            ['Address', request.address, comparisonResident.address || comparisonRegistration?.address || '', (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ')],
                          ].map(([label, submitted, stored, normalize]) => {
                            const comparison = label === 'Full name'
                              ? recoveryNamesMatch(submitted, stored) ? 'Matches' : 'Does not match'
                              : compareRecoveryValue(submitted, stored, normalize)
                            return <tr key={label}>
                              <th scope="row">{label}</th><td>{submitted || 'Not provided'}</td><td>{stored || 'Not recorded'}</td>
                              <td><span className={`recovery-comparison-status ${comparison === 'Matches' ? 'is-match' : comparison === 'Does not match' ? 'is-mismatch' : 'is-unavailable'}`}>{comparison}</span></td>
                            </tr>
                          })}
                          <tr><th scope="row">Resident code</th><td>Not requested on this form</td><td>{comparisonResident.code || 'Not recorded'}</td><td><span className="recovery-comparison-status is-unavailable">Staff reference</span></td></tr>
                        </tbody></table></div></TableSearch>
                      </section> : <p className="recovery-admin-warning">No existing resident record is available for comparison. Do not approve this recovery request until the resident is matched to an existing record.</p>}
                      {request.idPhoto?.dataUrl && <figure className="recovery-id-evidence"><a href={request.idPhoto.dataUrl} target="_blank" rel="noreferrer"><img src={request.idPhoto.dataUrl} alt={`ID evidence submitted by ${request.fullName}`} /></a><figcaption>{request.idPhoto.fileName || 'Submitted ID evidence'}</figcaption></figure>}
                      <div className="recovery-request-actions">
                        {request.status === 'Pending' && <button type="button" onClick={() => verifyRecoveryResident(request)}>Verify request</button>}
                        {request.status === 'Verified' && <button type="button" disabled={isSendingRecoveryNotice} onClick={() => reviewRecoveryRequest(request, 'Approved')}>Approve request</button>}
                        {['Pending', 'Verified'].includes(request.status) && !request.codeSentAt && <button type="button" className="table-delete" disabled={isSendingRecoveryNotice} onClick={() => reviewRecoveryRequest(request, 'Declined')}>{isSendingRecoveryNotice ? 'Sending notice…' : 'Decline request'}</button>}
                        {request.status === 'Approved' && !request.codeSentAt && <button type="button" className="check-button" onClick={() => sendApprovedRecoveryCode(request)}>Generate and email new code</button>}
                      </div>
                    </div>
                  </td></tr>}
                </Fragment>
                })}
                {!residentCodeRecoveryRequests.length && <tr><td colSpan="6">No resident code recovery requests have been submitted.</td></tr>}
              </tbody></table></div></TableSearch>
            </section> : <section className="resident-record-tab-panel">
              <section className="resident-record-subsection">
                <div className="requests-heading"><div><span className="section-number">REGISTRATION DECISIONS</span><h3>Rejected registration applications</h3><p>Review declined applications and the reason recorded for each decision.</p></div><span className="request-notification">{filteredDeclinedRegistrationRequests.length} of {declinedRegistrationRequests.length}</span></div>
                <div className="table-scroll rejected-registration-table-scroll"><table className="admin-table rejected-registration-table"><thead><tr><th>Request</th><th>Applicant</th><th>Address</th><th>Submitted</th><th>Reason for rejection</th><th>Decision date</th></tr></thead><tbody>{filteredDeclinedRegistrationRequests.map((request) => <tr key={request.id}>
                  <td data-label="Request"><span className="rejected-registration-request-id">{request.id}</span></td>
                  <td data-label="Applicant"><strong>{request.name}</strong></td>
                  <td data-label="Address">{request.address || 'Address not recorded'}</td>
                  <td data-label="Submitted">{request.submittedAt ? new Date(request.submittedAt).toLocaleDateString('en-PH') : 'Date not recorded'}</td>
                  <td data-label="Reason for rejection"><span className="rejected-registration-reason"><strong>Admin note</strong><span>{request.rejectionReason || 'No reason recorded'}</span></span></td>
                  <td data-label="Decision date">{request.reviewedAt ? new Date(request.reviewedAt).toLocaleDateString('en-PH') : 'Date not recorded'}</td>
                </tr>)}{filteredDeclinedRegistrationRequests.length === 0 && <tr><td colSpan="6">{declinedRegistrationRequests.length ? 'No rejected applications match your search.' : 'No rejected registration applications.'}</td></tr>}</tbody></table></div>
              </section>
            </section>}
            {residentProfileUpdateResidentCode && (() => {
              const selectedResident = adminResidents.find((resident) => resident.code?.toLowerCase() === residentProfileUpdateResidentCode.toLowerCase())
              const profileRequests = residentProfileUpdateRequests
                .filter((request) => request.residentCode?.toLowerCase() === residentProfileUpdateResidentCode.toLowerCase())
                .sort((first, second) => new Date(second.submittedAt).getTime() - new Date(first.submittedAt).getTime())
              return <div className="resident-profile-update-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setResidentProfileUpdateResidentCode('') }}>
                <section className="resident-profile-update-modal resident-profile-update-review-modal" role="dialog" aria-modal="true" aria-labelledby="resident-profile-update-modal-title">
                  <header><div><span className="section-number">RESIDENT RECORD</span><h2 id="resident-profile-update-modal-title">Profile update requests</h2><p>{selectedResident?.name || residentProfileUpdateResidentCode}</p></div><button type="button" aria-label="Close profile update requests" onClick={() => setResidentProfileUpdateResidentCode('')}>×</button></header>
                  {profileUpdateError && <p className="community-update-error" role="alert">{profileUpdateError}</p>}
                  {residentAccountMessage && <p className="resident-account-message" role="status">{residentAccountMessage}</p>}
                  <div className="resident-profile-update-request-list">
                    {profileRequests.map((request) => <article key={request.id}>
                      <div className="resident-profile-update-request-heading"><div><strong>{request.id}</strong><span>Submitted {request.submittedAt ? new Date(request.submittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</span></div><span className={`compliance-status ${request.status.toLowerCase()}`}>{request.status}</span></div>
                      <h3>Requested changes</h3>
                      <dl className="registration-data-grid">{Object.entries(request.proposedChanges || {}).map(([field, value]) => <div key={field}><dt>{({ birthDate: 'Date of birth', contactNumber: 'Contact number', emailAddress: 'Email address', address: 'Home address' })[field] || field}</dt><dd>{value || 'Not provided'}</dd></div>)}</dl>
                      {request.reviewedAt && <p className="resident-profile-update-reviewed">Reviewed {new Date(request.reviewedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</p>}
                      {request.status === 'Pending' && <div className="resident-profile-update-request-actions"><button type="button" onClick={() => reviewProfileUpdateRequest(request, 'Approved')}>Approve changes</button><button type="button" className="table-delete" onClick={() => reviewProfileUpdateRequest(request, 'Declined')}>Decline</button></div>}
                    </article>)}
                    {!profileRequests.length && <p>No profile update requests for this resident.</p>}
                  </div>
                </section>
              </div>
            })()}
          </section>}
          {adminView === 'certificateTemplates' && <section className="community-management-panel certificate-templates-workspace">
            <div className="requests-heading">
              <div><span className="section-number">SOURCE DOCUMENTS</span><h2>Certificate templates</h2></div>
              <div className="certificate-template-header-actions">
                <button type="button" className="resident-table-action" aria-expanded={isCustomTemplateFormOpen} aria-controls="certificate-template-upload-form" onClick={() => {
                  if (isCustomTemplateFormOpen) {
                    resetCustomTemplateForm()
                    setIsCustomTemplateFormOpen(false)
                  } else {
                    startAddingCustomCertificateTemplate()
                  }
                }}>{isCustomTemplateFormOpen ? (editingCertificateTemplate ? 'Cancel edit' : 'Close form') : 'Add document'}</button>
                <span className="request-notification">{enabledCertificateTypes.length} enabled</span>
              </div>
            </div>
            <p className="resident-report-note">Manage resident document types and their fees. New DOCX uploads receive the standard barangay header. Edits made in the in-browser editor preserve the selected template’s existing header and page layout.</p>
            {isCustomTemplateFormOpen && <form id="certificate-template-upload-form" ref={certificateTemplateUploadRef} className="certificate-template-upload" onSubmit={saveCustomCertificateTemplate}>
              <div><span className="section-number">{editingCertificateTemplate ? 'EDIT TEMPLATE' : 'ADD A TEMPLATE'}</span><h3>{editingCertificateTemplate ? `Replace the ${editingCertificateTemplate} layout` : 'Upload a resident document'}</h3><p>The scan reads the document text, underlined blanks, checkbox symbols, and checkbox-style lists. Each blank stays separate; checkbox options are grouped by their question. Review the counts and edit any unclear labels before residents use the form. Add required proof documents below.</p></div>
              {editingCertificateTemplate && <button type="button" className="resident-table-action certificate-template-content-editor-launch" onClick={() => setIsCertificateTemplateEditorOpen(true)}>Edit text, formatting, and pictures in browser</button>}
              <div className="certificate-template-upload-fields">
                <label>Document name<input type="text" value={customTemplateName} onChange={(event) => setCustomTemplateName(event.target.value)} maxLength="80" required readOnly={Boolean(editingCertificateTemplate)} /></label>
                <label>{editingCertificateTemplate ? 'Replacement DOCX file' : 'Original DOCX file'}<input type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => inspectCustomCertificateFile(event.target.files?.[0])} required={!customTemplateFile} /><small>DOCX only · 1.5 MB maximum</small></label>
              </div>
              {customTemplateFile && <div className="certificate-template-upload-actions">
                <button type="button" className="resident-table-action certificate-template-upload-preview-button" onClick={() => setIsCustomTemplatePreviewOpen(true)}>Preview uploaded DOCX</button>
                <button type="button" className="resident-table-action certificate-template-upload-preview-button" onClick={() => setIsCertificateTemplateEditorOpen(true)}>Edit layout before posting</button>
              </div>}
              {customTemplateFile && customTemplateDetectedFields.length > 0 && <section className="certificate-template-field-review" aria-label="Detected resident fields">
                <header><div><h4>Detected resident fields</h4><p>Compare these totals with the blanks and checkbox choices in the original document.</p></div></header>
                <div className="certificate-template-field-counts">
                  <span><strong>{customTemplateFieldCounts.blanks}</strong> blank fields</span>
                  <span><strong>{customTemplateFieldCounts.checkboxOptions}</strong> checkbox choices</span>
                  <span><strong>{customTemplateFieldCounts.checkboxGroups}</strong> checkbox groups</span>
                  {customTemplateFieldCounts.needsReview > 0 && <span className="needs-review"><strong>{customTemplateFieldCounts.needsReview}</strong> labels need review</span>}
                </div>
                <ol>{customTemplateFieldGroups.map((field, index) => {
                  const targetKeys = new Set(field.targets.map((target) => target.key))
                  const detectedField = customTemplateDetectedFields.find((candidate) => targetKeys.has(candidate.key))
                  const needsReview = field.targets.some((target) => (
                    customTemplateDetectedFields.find((candidate) => candidate.key === target.key)?.needsReview
                  ))
                  const blankNumber = customTemplateFieldGroups
                    .slice(0, index + 1)
                    .filter((candidate) => candidate.type !== 'checkbox').length
                  return <li key={`${field.key}-${field.targets[0]?.paragraph}-${field.targets[0]?.textNodeIndex}`}>
                    <div className="certificate-template-field-review-detail">
                      <strong>{field.type === 'checkbox' ? `${field.options?.length || field.targets.length} checkbox choices` : `Blank field ${blankNumber}`}</strong>
                      {detectedField?.context && <small>{detectedField.context}</small>}
                      {field.type === 'checkbox' && <small>{field.options?.join(' · ')} · {field.multiple ? 'Select all that apply' : 'Select one'}</small>}
                    </div>
                    <label>Label shown to residents<input
                      type="text"
                      value={field.label}
                      required
                      maxLength="100"
                      onChange={(event) => updateCustomTemplateFieldLabel(field, event.target.value)}
                    /></label>
                    {needsReview && <span className="certificate-template-field-needs-review">Needs review — choose a clear field name before saving.</span>}
                  </li>
                })}</ol>
              </section>}
              <label className="certificate-template-proof-fields">Required proof documents<textarea value={customTemplateRequirements} onChange={(event) => setCustomTemplateRequirements(event.target.value)} rows="2" placeholder={'Valid government ID\nProof of residency'} required /><small>One requirement per line. Use the exact text “Valid government ID” to show the existing front/back ID and PhilSys verification workflow.</small></label>
              {customTemplateError && <p className="community-update-error" role="alert">{customTemplateError}</p>}
              {customTemplateStatus && <p className="resident-account-message" role="status">{customTemplateStatus}</p>}
              <button type="submit" className="check-button" disabled={isSavingCustomTemplate || !customTemplateFile || !customTemplateDetectedFields.length || !isStorageLoaded}>{isSavingCustomTemplate ? 'Saving template…' : editingCertificateTemplate ? 'Update template layout' : 'Save custom template'}</button>
            </form>}
            {!isCustomTemplateFormOpen && customTemplateStatus && <p className="resident-account-message" role="status">{customTemplateStatus}</p>}
            <div className="certificate-template-grid">{allCertificateDocuments.map((document) => {
              const template = getCertificateTemplate(document, customCertificateTemplates)
              const isEnabled = enabledCertificateTypes.includes(document)
              const processingRequests = residentRequests.filter((request) => (
                request.status === 'Approved - scheduling'
                && request.documents.includes(document)
                && !request.printedDocuments?.[document]
              ))
              const isNavigationTarget = highlightedCertificateTemplate === document
              return <div className="certificate-template-item" key={document}>
                <article className={`certificate-template-card${isNavigationTarget ? ' is-navigation-target' : ''}`}>
                  <div><h3>{document}</h3><span className={`compliance-status ${isEnabled ? 'approved' : 'declined'}`}>{isEnabled ? 'Enabled' : 'Disabled'}</span></div>
                  <p>{template?.originalFilename || (template?.file ? template.file.split('/').pop() : 'No DOCX template is mapped')}</p>
                  {template?.custom && <small className="certificate-template-requirements">Proof: {template.requirements.join(' · ')}</small>}
                  <div className="table-actions">
                    <button type="button" disabled={!template} onClick={() => { setHighlightedCertificateTemplate(document); setProcessingTemplateDocument(document) }}>Process request <span className="certificate-template-request-count">{processingRequests.length}</span></button>
                    <button
                      type="button"
                      disabled={!template}
                      onPointerEnter={() => preloadCertificateTemplatePreview(document, customCertificateTemplates)
                        .catch((error) => console.error(`Unable to prepare the ${document} template preview.`, error))}
                      onFocus={() => preloadCertificateTemplatePreview(document, customCertificateTemplates)
                        .catch((error) => console.error(`Unable to prepare the ${document} template preview.`, error))}
                      onClick={() => setPreviewTemplateDocument(document)}
                    >Preview template</button>
                    <button type="button" className="certificate-template-edit" disabled={!template} onClick={() => openCertificateTemplateEditor(document)}>Edit layout</button>
                    <label className="template-enabled-toggle"><input type="checkbox" checked={isEnabled} onChange={() => toggleCertificateType(document)} />Available to residents</label>
                    {template?.overridesBuiltIn
                      ? <button type="button" className="table-delete" onClick={() => restoreBuiltInCertificateTemplate(template)}>Restore original</button>
                      : template?.custom && <button type="button" className="table-delete" onClick={() => deleteCustomCertificateTemplate(template)}>Delete template</button>}
                  </div>
                </article>
                <label className="certificate-template-fee">Fee per copy <span aria-hidden="true">₱</span><input type="number" min="0" step="0.01" value={documentFees[document] ?? 0} onChange={(event) => updateDocumentFee(document, event.target.value)} aria-label={`${document} fee per copy in pesos`} /></label>
              </div>
            })}</div>
            {previewTemplateDocument && <CertificateTemplatePreview document={previewTemplateDocument} onClose={() => setPreviewTemplateDocument(null)} customTemplates={customCertificateTemplates} />}
            {isCustomTemplatePreviewOpen && customTemplateFile && <CertificateTemplatePreview
              document={customTemplateName.trim() || customTemplateFile.name}
              uploadedFile={customTemplateFile}
              onClose={() => setIsCustomTemplatePreviewOpen(false)}
            />}
            {isCertificateTemplateEditorOpen && (editingCertificateTemplate || (isCustomTemplateFormOpen && customTemplateFile)) && <CertificateTemplateContentEditor
              document={editingCertificateTemplate || customTemplateName.trim() || customTemplateFile?.name || 'New document'}
              customTemplates={customCertificateTemplates}
              uploadedFile={!editingCertificateTemplate && isCustomTemplateFormOpen ? customTemplateFile : null}
              onClose={() => setIsCertificateTemplateEditorOpen(false)}
              onApply={editingCertificateTemplate ? applyCertificateTemplateEditorChanges : applyNewCertificateTemplateEditorChanges}
            />}
            {processingTemplateDocument && <CertificateTemplateRequestPicker
              document={processingTemplateDocument}
              requests={certificateTemplateProcessingRequests}
              viewedState={documentWorkflowViewedState}
              onClose={() => { setProcessingTemplateDocument(null); setHighlightedCertificateTemplate(null) }}
              onSelect={(request) => {
                request.processingRequestIds.forEach((requestId) => {
                  const sourceRequest = residentRequests.find((candidate) => candidate.id === requestId)
                  if (sourceRequest) markDocumentWorkflowViewed(sourceRequest)
                })
                setSelectedRequestId(null)
                setCertificateProcessingRequestId(request.id)
                setCertificateProcessingRequestGroupIds(request.processingRequestIds)
                setCertificateProcessingDocument(processingTemplateDocument)
                setProcessingTemplateDocument(null)
                setHighlightedCertificateTemplate(null)
                setAdminView('certificateProcessing')
              }}
            />}
          </section>}
          {adminView === 'issuedDocuments' && <section className="compliance-panel issued-documents-workspace">
            <div className="requests-heading"><div><span className="section-number">ISSUANCE REGISTER</span><h2>Issued documents</h2></div><span className="request-notification">{issuedDocuments.length} documents</span></div>
            <p className="resident-report-note">Each released certificate receives a unique control number and records its date, purpose, OR number, recipient, and issuing officer.</p>
            <TableSearch label="issued documents"><div className="table-scroll"><table className="admin-table issued-documents-table"><thead><tr><th>Control number</th><th>Date</th><th>Resident / recipient</th><th>Document</th><th>Purpose</th><th>OR number</th><th>Issuing officer</th><th>Action</th></tr></thead><tbody>{issuedDocuments.map((entry) => {
              const issuedRequest = historyRequestList.find((request) => request.id === entry.requestId)
              return <tr key={entry.id}>
                <td>{entry.controlNumber}</td>
                <td>{entry.date ? new Date(entry.date).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</td>
                <td>{entry.releasedTo || entry.resident}</td>
                <td>{entry.document}</td>
                <td>{entry.purpose || 'Not provided'}</td>
                <td>{entry.orNumber || '—'}</td>
                <td>{entry.issuingOfficer || '—'}</td>
                <td className="issued-document-action-cell"><IssuedDocumentHistoryButton entry={entry} request={issuedRequest} /></td>
              </tr>
            })}{issuedDocuments.length === 0 && <tr><td colSpan="8">No documents have been released yet.</td></tr>}</tbody></table></div></TableSearch>
          </section>}
          {adminView === 'residentHistory' && <section className="resident-history-page">
            <section className="compliance-panel resident-compliance-report">
              <div className="requests-heading"><div><span className="section-number">DOCUMENT REQUESTS</span><h2>Request history</h2></div><span className="report-date">Updated {new Date(`${reportDate}T00:00:00`).toLocaleDateString('en-PH', { dateStyle: 'long' })}</span></div>
              <p className="resident-report-note">Browse requests in a table. Use the final column to open a request’s information, requirements, status timeline, and saved certificates.</p>
              <div className="resident-history-stats">
                {[['All requests', historyRequestStats.total], ['In progress', historyRequestStats.processing], ['Ready for release', historyRequestStats.ready], ['Declined', historyRequestStats.declined]].map(([label, count]) => <div className="resident-history-stat" key={label}><span>{label}</span><strong>{count}</strong></div>)}
              </div>
              <div className="history-filter-row">
                <label className="history-search"><span className="sr-only">Search request history</span><input type="search" value={historySearch} onChange={(event) => setHistorySearch(event.target.value)} placeholder="Search resident, request ID, document, or status" /></label>
                <label className="history-status-filter">Status<select value={historyStatusFilter} onChange={(event) => setHistoryStatusFilter(event.target.value)}><option value="all">All statuses</option>{historyStatusOptions.map((status) => <option value={status} key={status}>{status}</option>)}</select></label>
                {(historySearch || historyStatusFilter !== 'all') && <button type="button" className="history-filter-reset" onClick={() => { setHistorySearch(''); setHistoryStatusFilter('all') }}>Clear filters</button>}
                <p className="history-result-count" aria-live="polite">Showing <strong>{filteredHistoryRequests.length}</strong> of {historyRequestList.length} requests</p>
              </div>
              <div className="resident-history-table-wrap">
                <table className="resident-history-table resident-admin-request-history">
                  <thead><tr><th>Resident</th><th>Request ID</th><th>Documents</th><th>Submitted</th><th>Status</th><th>Action</th></tr></thead>
                  <tbody>{filteredHistoryRequests.map((request) => <tr key={request.id}>
                    <td data-label="Resident"><strong>{request.resident}</strong><small>{request.residentCode || 'Resident code not recorded'}</small></td>
                    <td data-label="Request ID"><strong>{request.id}</strong></td>
                    <td data-label="Documents">{(request.documents || []).join(' · ') || 'No documents listed'}</td>
                    <td data-label="Submitted">{request.requestedAt ? new Date(request.requestedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' }) : request.date || 'Date not recorded'}</td>
                    <td data-label="Status"><span className={`compliance-status ${request.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{request.status}</span></td>
                    <td data-label="Action"><button type="button" className="open-request" onClick={() => { setSelectedHistoryRequestId(request.id); setSelectedFinishedCertificate(null) }} aria-label={`View details for ${request.id}`}>View details</button></td>
                  </tr>)}
                    {filteredHistoryRequests.length === 0 && <tr><td className="resident-table-empty" colSpan="6">{historyRequestList.length ? 'No request history matches your search or status filter.' : 'No document requests have been recorded yet.'}</td></tr>}
                  </tbody>
                </table>
              </div>
              {selectedHistoryRequest && <div className="resident-history-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelectedHistoryRequestId(null); setSelectedFinishedCertificate(null) } }}>
                <section className="resident-history-modal" role="dialog" aria-modal="true" aria-labelledby="resident-history-modal-title">
                  <header className="resident-history-modal-header"><div><span className="section-number">REQUEST DETAILS</span><h2 id="resident-history-modal-title">{selectedHistoryRequest.resident}</h2><p>{selectedHistoryRequest.id} · {selectedHistoryRequest.residentCode || 'Resident code not recorded'}</p></div><button type="button" className="resident-history-modal-close" onClick={() => { setSelectedHistoryRequestId(null); setSelectedFinishedCertificate(null) }} aria-label="Close request details">×</button></header>
                  <div className="resident-history-modal-content">
                    <div className="resident-history-modal-summary"><div><span>Requested documents</span><strong>{(selectedHistoryRequest.documents || []).join(' · ') || 'No documents listed'}</strong></div><div><span>Current status</span><strong><span className={`compliance-status ${selectedHistoryRequest.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{selectedHistoryRequest.status}</span></strong></div><div><span>Submitted</span><strong>{selectedHistoryRequest.requestedAt ? new Date(selectedHistoryRequest.requestedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : selectedHistoryRequest.date || 'Date not recorded'}</strong></div></div>
                    <section className="resident-history-modal-section"><h3>Submitted information</h3><dl className="resident-history-modal-details">{Object.entries(selectedHistoryRequest.details || {}).map(([label, value]) => <div key={label}><dt>{label.replace(/([A-Z])/g, ' $1')}</dt><dd>{value || 'Not provided'}</dd></div>)}{!Object.keys(selectedHistoryRequest.details || {}).length && <p>No additional request information was recorded.</p>}</dl></section>
                    <section className="resident-history-modal-section"><h3>Submitted requirements</h3><ul className="resident-history-requirements">{(selectedHistoryRequest.requirements || []).map((requirement) => <li key={requirement}>{requirement}</li>)}{!(selectedHistoryRequest.requirements || []).length && <li>No requirements recorded</li>}</ul></section>
                    <section className="resident-history-modal-section">
                      <h3>Status timeline</h3>
                      <ol className="history-status-timeline">
                        {(selectedHistoryRequest.statusHistory || withRequestStatusHistory(selectedHistoryRequest).statusHistory).map((entry, index) => (
                          <li className={entry.status === selectedHistoryRequest.status ? 'is-current' : ''} key={`${entry.status}-${entry.changedAt}-${index}`}>
                            <span className={`history-status-marker ${entry.status.toLowerCase().replace(/[^a-z]+/g, '-')}`} aria-hidden="true">{entry.status === 'Completed' ? '✓' : entry.status === 'Declined' ? '!' : index + 1}</span>
                            <div><strong>{entry.status}</strong><time>{entry.changedAt && !Number.isNaN(new Date(entry.changedAt).getTime()) ? new Date(entry.changedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</time></div>
                          </li>
                        ))}
                      </ol>
                    </section>
                    {selectedHistoryRequest.certificateData && <section className="resident-history-modal-section"><h3>Saved certificates</h3><div className="resident-history-certificate-actions">{Object.keys(selectedHistoryRequest.certificateData).map((document) => <div className="saved-certificate-action-row" key={document}><button type="button" className="open-request" onClick={() => setSelectedFinishedCertificate({ requestId: selectedHistoryRequest.id, document })}>Review {document}</button><SavedCertificateDownloadButton document={document} certificateData={selectedHistoryRequest.certificateData[document]} requestId={selectedHistoryRequest.id} customTemplates={customCertificateTemplates} /></div>)}</div>{selectedFinishedCertificate?.requestId === selectedHistoryRequest.id && <SavedCertificateReview document={selectedFinishedCertificate.document} certificateData={selectedHistoryRequest.certificateData[selectedFinishedCertificate.document]} requestId={selectedHistoryRequest.id} onClose={() => setSelectedFinishedCertificate(null)} customTemplates={customCertificateTemplates} />}</section>}
                  </div>
                </section>
              </div>}
            </section>
            <section className="compliance-panel resident-history-log">
              <div className="requests-heading"><div><span className="section-number">EXPORTABLE REPORT</span><h2>Document request reports</h2></div><button type="button" className="check-button" onClick={exportDocumentReport}>Export CSV</button></div>
              <p className="resident-report-note">Request counts grouped by document type, request month, and current status. Export the same report as a spreadsheet-ready CSV.</p>
              <TableSearch label="document request reports"><div className="table-scroll"><table className="admin-table"><thead><tr><th>Month</th><th>Document type</th><th>Status</th><th>Requests</th></tr></thead><tbody>{documentReportRows.map((row) => <tr key={row.key}><td>{row.month}</td><td>{row.document}</td><td>{row.status}</td><td>{row.count}</td></tr>)}{documentReportRows.length === 0 && <tr><td colSpan="4">No document request data is available for reporting.</td></tr>}</tbody></table></div></TableSearch>
            </section>
          </section>}
          {adminView === 'settings' && <section className="admin-account-page">
            <header className="admin-account-page-heading">
              <span className="admin-account-page-icon" aria-hidden="true">⚙</span>
              <div><p className="section-number">ADMIN PREFERENCES</p><h2>Dashboard settings</h2><p>Adjust how the admin workspace looks on this device.</p></div>
            </header>
            <section className="admin-account-card">
              <div className="admin-account-card-heading"><span className="admin-account-card-icon" aria-hidden="true">Aa</span><div><h3>Display</h3><p>Choose your preferred reading and viewing options.</p></div></div>
              <div className="admin-account-setting-row"><div><strong>Text size</strong><small>Adjust text size across the admin dashboard.</small></div><select aria-label="Dashboard text size" value={fontSize} onChange={(event) => setFontSize(event.target.value)}><option value="standard">Standard</option><option value="large">Large</option></select></div>
              <div className="admin-account-setting-row"><div><strong>Dark appearance</strong><small>Use a darker color scheme for the admin workspace.</small></div><label className="admin-setting-switch"><span className="sr-only">Dark appearance</span><input type="checkbox" checked={darkMode} onChange={(event) => setDarkMode(event.target.checked)} /><span aria-hidden="true" /></label></div>
              <p className="admin-settings-saved-note" role="status">Display preferences are saved in this browser.</p>
            </section>
          </section>}
          {adminView === 'security' && <section className="admin-account-page">
            <header className="admin-account-page-heading">
              <span className="admin-account-page-icon security" aria-hidden="true">◇</span>
              <div><p className="section-number">ACCOUNT PROTECTION</p><h2>Security &amp; devices</h2><p>Review this browser session and choose an inactivity sign-out time.</p></div>
            </header>
            <section className="admin-account-card">
              <div className="admin-account-card-heading"><span className="admin-account-card-icon device" aria-hidden="true">▣</span><div><h3>This device</h3><p>Current browser and session on this device.</p></div><span className="admin-device-active"><i aria-hidden="true" /> Active</span></div>
              <div className="admin-device-details"><div><span>Browser &amp; platform</span><strong>{getAdminDeviceLabel()}</strong></div><div><span>Session type</span><strong>Admin dashboard · this browser only</strong></div></div>
              <div className="admin-account-setting-row"><div><strong>Automatic sign-out</strong><small>Sign out after no activity for the selected time.</small></div><select aria-label="Automatic sign-out time" value={autoLogoutMinutes} onChange={(event) => setAutoLogoutMinutes(Number(event.target.value))}><option value={15}>15 minutes</option><option value={30}>30 minutes</option><option value={60}>1 hour</option><option value={0}>Never</option></select></div>
              <p className="admin-security-notice">This setting is a browser-side safety feature, not a replacement for server-managed authentication or device/session revocation.</p>
            </section>
            <section className="admin-account-card">
              <div className="admin-account-card-heading"><span className="admin-account-card-icon email" aria-hidden="true">@</span><div><h3>Admin invitations</h3><p>Invite a Gmail address. It only becomes an admin account after the recipient accepts the emailed invitation.</p></div></div>
              <form className="admin-email-add-form" onSubmit={addAdminEmail}>
                <label htmlFor="new-admin-email">Invite by email</label>
                <div><input id="new-admin-email" type="email" value={newAdminEmail} onChange={(event) => { setNewAdminEmail(event.target.value); setAdminInvitationError(''); setAdminInvitationMessage('') }} placeholder="name@gmail.com" required /><button type="submit" className="admin-email-action primary" disabled={isSendingAdminInvitation || !officialBackendToken}>{isSendingAdminInvitation ? 'Sending…' : 'Send invitation'}</button></div>
              </form>
              {!officialBackendToken && <p className="admin-security-notice">Sign in with an active backend administrator account to send invitations.</p>}
              {adminInvitationError && <p className="admin-invitation-error" role="alert">{adminInvitationError}</p>}
              {adminInvitationMessage && <p className="admin-settings-saved-note" role="status">{adminInvitationMessage}</p>}
              <div className="admin-invitation-list-heading"><strong>Invitation history</strong>{isLoadingAdminInvitations && <small>Refreshing…</small>}</div>
              <ul className="admin-account-email-list admin-invitation-list">
                {adminInvitations.map((invitation) => {
                  const statusLabel = {
                    pending: 'Awaiting response',
                    accepted: 'Accepted',
                    declined: 'Declined',
                    expired: 'Expired',
                  }[invitation.status] || invitation.status
                  return <li key={invitation.id}>
                    <div><strong>{invitation.email}</strong><small>Sent {invitation.createdAt ? new Date(invitation.createdAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'date unavailable'}</small></div>
                    <span className={`admin-invitation-status is-${invitation.status}`}>{statusLabel}</span>
                  </li>
                })}
                {!adminInvitations.length && !isLoadingAdminInvitations && <li><span className="admin-account-email-address">No invitations yet.</span></li>}
              </ul>
            </section>
            <section className="admin-account-card admin-security-password-card">
              <div className="admin-account-card-heading"><span className="admin-account-card-icon password" aria-hidden="true">⌑</span><div><h3>Change admin password</h3><p>Update the configured password for this running session.</p></div></div>
              <form className="password-change-form admin-security-password-form" onSubmit={submitPasswordChange}>
                <label htmlFor="current-admin-password">Current password</label>
                <input id="current-admin-password" type="password" value={passwordFields.current} onChange={(event) => setPasswordFields({ ...passwordFields, current: event.target.value })} autoComplete="current-password" required />
                <label htmlFor="new-admin-password">New password</label>
                <input id="new-admin-password" type="password" value={passwordFields.next} onChange={(event) => setPasswordFields({ ...passwordFields, next: event.target.value })} autoComplete="new-password" required />
                <label htmlFor="confirm-admin-password">Confirm new password</label>
                <input id="confirm-admin-password" type="password" value={passwordFields.confirm} onChange={(event) => setPasswordFields({ ...passwordFields, confirm: event.target.value })} autoComplete="new-password" required />
                <button type="submit">Update password</button>
                <p className="admin-security-notice" role="status">{passwordMessage || 'Password changes apply only for this running session. Use server-side authentication to securely store account credentials.'}</p>
              </form>
            </section>
          </section>}
          </div>
          </div>
        </section>
      ) : showOfficialLogin ? (
        <section className="official-login-page">
          <div className="official-login-card">
            <button type="button" className="official-login-back" onClick={returnHome} aria-label="Back to access portal"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg></button>
            <div className="official-login-seal"><img src={barangaySeal} alt="" /></div>
            <h1 className="official-login-title">Official Login</h1>
            <form className="official-login-form" onSubmit={submitOfficialLogin}>
              <label htmlFor="official-username">Admin email</label>
              <input id="official-username" type="email" value={officialCredentials.username} onChange={(event) => { setOfficialCredentials({ ...officialCredentials, username: event.target.value }); setLoginStatus('') }} placeholder="Enter your admin email" autoComplete="email" required />
              <label htmlFor="official-password">Password</label>
              <input id="official-password" type="password" value={officialCredentials.password} onChange={(event) => { setOfficialCredentials({ ...officialCredentials, password: event.target.value }); setLoginStatus('') }} placeholder="Enter your password" autoComplete="current-password" required />
              <button type="submit" className="check-button">Log in</button>
              <p className="login-status" aria-live="polite">{loginStatus}</p>
            </form>
          </div>
        </section>
      ) : showResidentInboxPage ? (
        <section className="resident-inbox-page resident-account-shell">
          <header className="resident-account-header">
            <div className="resident-account-header-top">
              <div className="resident-account-header-brand">
                <div className="resident-account-brand"><img src={barangaySeal} alt="" /><span><strong>Barangay Bagong Bayan 1</strong></span></div>
              </div>
              <div className="resident-account-header-actions">
                {!registrationCommunityOnlyAccess && <button type="button" className="resident-account-new-request" onClick={() => chooseResidentPath('request')}><span aria-hidden="true">＋</span>New request</button>}
                {!registrationCommunityOnlyAccess && <button type="button" className="resident-account-icon-button" aria-label="About Barangay Bagong Bayan I" title="About" onClick={openAboutPage}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" /></svg>
                </button>}
                {!registrationCommunityOnlyAccess && <div className="resident-account-menu-wrap">
                  <button type="button" className="resident-account-icon-button notification-button" aria-label={`Notifications (${residentNotificationUnreadCount} unread)`} aria-expanded={notificationsOpen} onClick={() => {
                    if (!notificationsOpen) markResidentUpdatesRead('notifications', residentNotificationItems.map((item) => item.id))
                    setNotificationsOpen((open) => !open)
                  }}>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
                    {residentNotificationUnreadCount > 0 && <span className="resident-account-notification-count">{residentNotificationUnreadCount}</span>}
                  </button>
                  {notificationsOpen && <div className="resident-account-popover resident-account-notifications">
                    <strong>Recent updates</strong>
                    {residentNotificationItems.slice(0, 10).map((item) => <button type="button" key={item.id} onClick={() => {
                      markResidentUpdatesRead('notifications', residentNotificationItems.map((notification) => notification.id))
                      if (item.category === 'cancelled') {
                        setResidentDraftsCorrectionsTab('cancelled')
                        markResidentDashboardSectionRead('drafts-corrections', 'cancelled')
                      } else if (item.section === 'requests') {
                        if (item.requestId) markResidentRequestUpdatesRead(item.requestId)
                        else markResidentDashboardSectionRead('requests')
                      } else if (item.section === 'pickup' && item.requestId) {
                        markResidentUpdatesRead('pickup', residentPickupUpdateItems
                          .filter((pickupItem) => pickupItem.requestId === item.requestId)
                          .map((pickupItem) => pickupItem.id))
                      } else if (item.section === 'payments' && item.requestId) {
                        markResidentUpdatesRead('payments', residentPaymentUpdateItems
                          .filter((paymentItem) => paymentItem.requestId === item.requestId)
                          .map((paymentItem) => paymentItem.id))
                      } else if (item.section === 'history' && item.requestId) {
                        markResidentUpdatesRead('history', residentHistoryUpdateItems
                          .filter((historyItem) => historyItem.requestId === item.requestId)
                          .map((historyItem) => historyItem.id))
                      } else if (item.section === 'community') {
                        markResidentUpdatesRead('community', [item.id])
                        setResidentCommunityTab('announcements')
                      } else if (item.section === 'profile') {
                        markResidentUpdatesRead('profile', [item.id])
                      } else if (item.section !== 'pickup') {
                        markResidentDashboardSectionRead(item.section)
                      }
                      setSelectedInboxRequestId(item.section === 'requests' ? item.requestId || null : null)
                      setSelectedResidentHistoryRequestId(item.section === 'history' ? item.requestId || null : null)
                      setResidentDashboardSection(item.section)
                      setNotificationsOpen(false)
                    }}><span>{item.title}</span><small>{item.description}</small>{item.time && <time>{item.time}</time>}</button>)}
                    {!residentNotificationItems.length && <p>You’re all caught up. New request updates from the barangay office will appear here.</p>}
                    <button type="button" className="resident-account-popover-footer" onClick={() => { markResidentUpdatesRead('notifications', residentNotificationItems.map((item) => item.id)); setSelectedInboxRequestId(null); setSelectedResidentHistoryRequestId(null); setResidentDashboardSection('requests'); setNotificationsOpen(false) }}>View My Requests</button>
                  </div>}
                </div>}
                <button type="button" className="resident-account-logout-button resident-account-header-logout" aria-label="Log out" onClick={returnHome}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg>
                  <span>Log out</span>
                </button>
              </div>
            </div>
          </header>
          <div className="resident-dashboard-layout">
            <aside className="resident-dashboard-sidebar" aria-label="Resident dashboard menu">
              {!registrationCommunityOnlyAccess && <button type="button" className={`resident-dashboard-sidebar-profile${residentDashboardSection === 'profile' ? ' active' : ''}`} aria-current={residentDashboardSection === 'profile' ? 'page' : undefined} aria-label={`Open My Profile for ${fullName}`} onClick={() => {
                setSelectedInboxRequestId(null)
                setSelectedResidentHistoryRequestId(null)
                markResidentDashboardSectionRead('profile')
                setResidentDashboardSection('profile')
                setResidentMobileMenuOpen(false)
                setProfileOpen(false)
                setNotificationsOpen(false)
              }}>
                <span className="resident-dashboard-sidebar-avatar" aria-hidden="true">{fullName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase()}</span>
                <span><strong>{fullName}</strong><small>{residentName.code || 'Resident account'}</small><small className="resident-dashboard-sidebar-date">{new Date().toLocaleDateString('en-PH', { dateStyle: 'medium' })}</small></span>
                {residentProfileUnreadCount > 0 && <span className="resident-request-new-dot" role="img" aria-label="New profile update" title="New profile update" />}
              </button>}
              <button
                type="button"
                className="resident-mobile-menu-toggle"
                aria-expanded={residentMobileMenuOpen}
                aria-controls="resident-dashboard-navigation"
                onClick={() => setResidentMobileMenuOpen((open) => !open)}
              >
                <span><span className="resident-mobile-menu-icon" aria-hidden="true">☰</span>{residentDashboardSection === 'profile' ? 'My Profile' : residentDashboardSections.find((section) => section.id === residentDashboardSection)?.title || 'Dashboard menu'}</span>
                <span>{residentMobileMenuOpen ? 'Close menu' : 'Menu'}</span>
              </button>
              <p className="resident-dashboard-sidebar-label">MENU</p>
              <nav id="resident-dashboard-navigation" className={`resident-dashboard-nav${residentMobileMenuOpen ? ' is-mobile-menu-open' : ''}`} aria-label="Resident dashboard">
                {residentDashboardSections.filter((section) => registrationCommunityOnlyAccess
                  ? section.id === 'community'
                  : section.id !== 'profile').map((section) => {
                    const unreadCount = residentDashboardSectionUnreadCounts[section.id] || 0
                    return <button type="button" className={`${residentDashboardSection === section.id ? 'active' : ''}${unreadCount > 0 ? ' has-unread-updates' : ''}`} aria-current={residentDashboardSection === section.id ? 'page' : undefined} key={section.id} onClick={() => {
                      if (residentDashboardSection === 'request-documents') preserveActiveResidentDraft()
                      if (section.id !== 'requests') {
                        setResidentCancellationRequestId('')
                        setCancellationGcashError('')
                      }
                      if (section.id === 'drafts-corrections') {
                        if (residentDraftsCorrectionsTab === 'cancelled') markResidentDashboardSectionRead(section.id, 'cancelled')
                      } else {
                        markResidentDashboardSectionRead(section.id)
                      }
                      if (section.id === 'payments') {
                        residentDashboardContentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
                      }
                      setSelectedInboxRequestId(null)
                      setSelectedResidentHistoryRequestId(null)
                      setResidentDashboardSection(section.id)
                      setResidentMobileMenuOpen(false)
                    }}>
                      <span className="resident-dashboard-nav-icon" aria-hidden="true">{section.icon}</span>{section.title}
                      {unreadCount > 0 && <span className="resident-request-new-dot" role="img" aria-label="New update" title="New update" />}
                      {unreadCount > 0 && <span className="resident-dashboard-nav-count" aria-label={`${unreadCount} unread updates`}>{unreadCount}</span>}
                    </button>
                  })}
              </nav>
            </aside>
            <main className="resident-dashboard-main">
              {!registrationCommunityOnlyAccess && !isDatabaseConnected && !isResidentDatabaseConnected && (residentDatabaseSyncError || databaseSaveError) && <div className="resident-database-sync-warning" role="status">
                <strong>Shared database is not connected</strong>
                <p>Changes made now are saved only in this browser and will not appear on the barangay’s other devices until the connection is restored.</p>
                {(residentDatabaseSyncError || databaseSaveError) && <small>{residentDatabaseSyncError || databaseSaveError}</small>}
              </div>}
              <div className="resident-inbox-page-content" ref={residentDashboardContentRef}>
            {selectedInboxRequest && residentDashboardSection !== 'requests' ? (
              <article className="resident-request-detail-page">
                <div className="resident-request-detail-heading">
                  <div>
                    <p className="resident-inbox-request-id">{selectedInboxRequest.id} · Submitted {selectedInboxRequest.requestedAt ? new Date(selectedInboxRequest.requestedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : selectedInboxRequest.date}</p>
                    <h2>{selectedInboxRequest.documents.join(' · ')}</h2>
                  </div>
                  <span className={`resident-status-badge ${selectedInboxRequest.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{residentStatusLabels[selectedInboxRequest.status] || selectedInboxRequest.status}</span>
                </div>
                <ResidentRequestDetailContent
                  request={selectedInboxRequest}
                  relatedRequests={[...residentAccountRequests, ...residentPendingPaymentRequests]}
                  customTemplates={customCertificateTemplates}
                />
              </article>
            ) : residentDashboardSection === 'request-documents' ? (
              <section className="resident-dashboard-section resident-document-request-section">
                <div className="resident-request-heading">
                  <span className="resident-request-heading-art" aria-hidden="true">
                    <svg viewBox="0 0 64 64" fill="none" focusable="false"><path d="M17 8h19l12 12v35H17z" /><path d="M36 8v13h12M24 31h17M24 38h17" /><path d="m22 48 5 5 13-13" /></svg>
                  </span>
                  <div className="resident-request-heading-copy"><span className="section-number">RESIDENT DOCUMENT SERVICES</span><h2>Certificates &amp; permits</h2><p>Newly added certificate documents appear here automatically. Select what you need; your progress saves automatically.</p></div>
                  <div className="resident-request-selection-count"><strong>{String(selectedDocuments.length).padStart(2, '0')}</strong><span>selected</span></div>
                </div>
                <div className="resident-document-request-grid">
                  {allCertificateDocuments.filter((document) => enabledCertificateTypes.includes(document)).map((document, index) => {
                    const requirements = getDocumentRequirements(document, customCertificateTemplates)
                    const isSelected = selectedDocuments.includes(document)
                    return <label className={`resident-document-request-card${isSelected ? ' selected' : ''}`} key={document}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleDocument(document)} />
                      <span className="resident-document-request-card-icon">
                        <ResidentDocumentIcon document={document} />
                      </span>
                      <span className="resident-document-request-card-copy"><small>DOCUMENT {String(index + 1).padStart(2, '0')}</small><strong>{document}</strong><span><i aria-hidden="true" />{requirements.length} requirement{requirements.length === 1 ? '' : 's'} to prepare</span><span className="resident-document-fee">₱{Number(documentFees[document] || 0).toFixed(2)} per copy</span></span>
                      <span className="resident-document-request-check" aria-hidden="true">{isSelected ? '✓' : '+'}</span>
                    </label>
                  })}
                  {!enabledCertificateTypes.length && <p className="resident-profile-note">There are no document types currently available. Please contact the barangay office for assistance.</p>}
                </div>
                <div className="resident-document-request-footer">
                  <div className="resident-document-selection-summary">
                    <span className="resident-selection-summary-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M5 4h14v16H5zM8 9h8M8 13h8M8 17h5" /></svg></span>
                    <div><strong>{selectedDocuments.length ? 'Your selection' : 'Start by selecting a document'}</strong><span>{selectedDocuments.length ? `${selectedDocuments.length} document${selectedDocuments.length === 1 ? '' : 's'} ready to review · Estimated total ₱${getSelectedRequestFeeTotal()?.toFixed(2) ?? '—'}` : 'Choose one or more certificates or permits above.'}</span></div>
                  </div>
                  <div className="resident-document-request-actions">
                    <button type="button" className="resident-request-guide-button" disabled={!selectedDocuments.length} onClick={() => { setResidentDocumentGuideReviewed(false); setResidentDocumentGuideOpen(true) }}>View requirements</button>
                  </div>
                </div>
                {residentDraftError && <p className="resident-draft-error" role="alert">{residentDraftError}</p>}
                {residentDocumentGuideOpen && <ResidentDocumentGuide
                  documents={selectedDocuments}
                  customTemplates={customCertificateTemplates}
                  onClose={() => setResidentDocumentGuideOpen(false)}
                  onAcknowledge={() => {
                    setResidentDocumentGuideReviewed(true)
                    setResidentDocumentGuideOpen(false)
                    continueDashboardRequest(true)
                  }}
                />}
              </section>
            ) : residentDashboardSection === 'requests' ? (
              <>
            {residentInboxRequests.length > 0 && <header className="resident-request-category-heading">
              <div>
                <span className="section-number">REQUEST CENTER</span>
                <h2>My Requests</h2>
                <p>Track document requests and see the latest updates from the barangay office.</p>
              </div>
              <div className="resident-request-heading-summary">
                <span className="resident-request-count-pill">{residentInboxRequests.filter((request) => request.status !== 'Completed').length} requests</span>
                {residentRequestUnreadCount > 0 && <span className="resident-request-updates-pill" aria-label={`${residentRequestUnreadCount} unread request updates`}>
                  <span className="resident-unread-update-count">{residentRequestUnreadCount}</span>
                  {residentRequestUnreadCount} new {residentRequestUnreadCount === 1 ? 'update' : 'updates'}
                </span>}
              </div>
            </header>}
            {(() => {
              const requestsByDate = residentInboxRequests.slice().sort((first, second) => new Date(second.requestedAt || second.date).getTime() - new Date(first.requestedAt || first.date).getTime())
              const activeRequests = requestsByDate.filter((request) => request.status !== 'Completed')
              if (!requestsByDate.length) {
                return <div className="resident-inbox-no-requests"><h2>{residentCancelledRequests.length ? 'No active requests' : 'No document requests yet'}</h2><p>{residentCancelledRequests.length ? 'Cancelled requests are saved in Drafts & corrections.' : 'After you submit a document request, its status and updates will appear here.'}</p>{residentCancelledRequests.length ? <button type="button" className="resident-history-link" onClick={() => { setResidentDraftsCorrectionsTab('cancelled'); markResidentDashboardSectionRead('drafts-corrections', 'cancelled'); setResidentDashboardSection('drafts-corrections') }}>View cancelled requests</button> : <button type="button" className="check-button" onClick={() => chooseResidentPath('request')}>Start a document request</button>}</div>
              }
              return activeRequests.length ? (
                  <div className="resident-inbox-page-list resident-my-requests-grid">
                    {activeRequests.map((request) => {
                      const statusLabel = residentStatusLabels[request.status] || request.status
                      const statusClass = request.status.toLowerCase().replace(/[^a-z]+/g, '-')
                      const requestFeeAmount = Number(request.feeAmount ?? (
                        Number(request.unitFeeAmount || 0) * (Number(request.copyCount) || 1)
                      ))
                      const paymentStatusLabel = request.paymentStatus === 'Paid'
                        ? 'Paid'
                        : request.paymentStatus === 'Pending verification'
                          ? 'Pending verification'
                          : 'Unpaid'
                      const unreadRequestUpdates = residentRequestUpdateItems.filter((item) => item.requestId === request.id && isResidentUpdateUnread(item))
                      const latestActivity = (request.activity || []).slice(-1)[0]
                      const submittedDate = request.requestedAt
                        ? new Date(request.requestedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })
                        : request.date || 'Date not recorded'
                      const requestNote = request.status === 'Returned for edits'
                        ? { label: 'Action needed', text: request.editRequestNote || 'Please review the requested changes in the request details.' }
                        : request.status === 'Declined'
                          ? { label: 'Office update', text: request.declineReason || 'Please contact the barangay office for next steps.' }
                          : request.pickupNotificationSentAt && request.pickupDate
                            ? { label: 'Pickup scheduled', text: `${formatPickupSchedule(request.pickupDate, request.pickupTime)}${request.pickupInstructions ? ` · ${request.pickupInstructions}` : ''}` }
                            : latestActivity
                              ? { label: 'Latest update', text: latestActivity.action }
                              : { label: 'What happens next', text: 'The barangay office will update this request as it moves through processing.' }
                      return <article className={`resident-inbox-item resident-request-list-item resident-my-request-card ${statusClass}${unreadRequestUpdates.length ? ' has-unread-update' : ''}`} key={request.id}>
                        <div className="resident-inbox-item-heading">
                          <div>
                            <p className="resident-inbox-request-id">REQUEST · {request.id}</p>
                            <strong>{request.documents?.join(' · ') || 'Document request'}</strong>
                            {unreadRequestUpdates.length > 0 && <span className="resident-my-request-update-badge">{unreadRequestUpdates.length} new {unreadRequestUpdates.length === 1 ? 'update' : 'updates'}</span>}
                            {requestFeeAmount > 0 && <span className={`resident-my-request-payment-badge${request.paymentStatus === 'Paid' ? ' is-paid' : ''}`}>
                              {paymentStatusLabel}: ₱{requestFeeAmount.toFixed(2)}
                            </span>}
                          </div>
                          <span className="resident-request-status-wrap">
                            <span className={`resident-status-badge ${statusClass}`}>{statusLabel}</span>
                            {unreadRequestUpdates.length > 0 && <span className="resident-request-new-dot" role="img" aria-label="New update" title="New update" />}
                          </span>
                        </div>
                        <div className="resident-my-request-meta">
                          <div><span>Submitted</span><strong>{submittedDate}</strong></div>
                          {request.details?.purpose && <div><span>Purpose</span><strong>{request.details.purpose}</strong></div>}
                          <div><span>Documents</span><strong>{request.documents?.length || 0} requested</strong></div>
                        </div>
                        <div className={`resident-my-request-note ${request.status === 'Returned for edits' ? 'needs-action' : request.status === 'Declined' ? 'is-declined' : request.pickupNotificationSentAt ? 'has-pickup' : ''}${unreadRequestUpdates.length ? ' has-unread-update' : ''}`}>
                          <span className="resident-my-request-note-icon" aria-hidden="true">{request.status === 'Returned for edits' ? '!' : request.pickupNotificationSentAt ? '◷' : 'i'}</span>
                          <div><strong>{requestNote.label}</strong><p>{requestNote.text}</p>{latestActivity?.time && <small>{latestActivity.by} · {latestActivity.time}</small>}</div>
                        </div>
                        <footer className="resident-my-request-footer">
                          <span>{request.status === 'New' ? 'Cancellation is available until review begins.' : 'Cancellation is unavailable after review begins.'}</span>
                          <div className="resident-my-request-actions">
                            <button type="button" className="resident-request-list-action" onClick={() => { markResidentRequestUpdatesRead(request.id); setSelectedInboxRequestId(request.id) }}>View request details <span aria-hidden="true">→</span></button>
                            {request.status === 'New' && <button type="button" className="resident-request-cancel-action" onClick={() => cancelResidentRequest(request)}>Cancel request</button>}
                          </div>
                        </footer>
                      </article>
                    })}
                  </div>
                ) : <div className="resident-inbox-no-requests resident-category-empty"><h2>No active requests</h2><p>{residentCancelledRequests.length ? 'Cancelled requests are saved separately in Drafts & corrections.' : 'All of your submitted requests are in history.'}</p>
                  {requestsByDate.some((request) => ['Completed', 'Declined'].includes(request.status)) && <button type="button" className="resident-history-link" onClick={() => setResidentDashboardSection('history')}>View completed and declined requests in history</button>}
                  {residentCancelledRequests.length > 0 && <button type="button" className="resident-history-link" onClick={() => { setResidentDraftsCorrectionsTab('cancelled'); markResidentDashboardSectionRead('drafts-corrections', 'cancelled'); setResidentDashboardSection('drafts-corrections') }}>View cancelled requests</button>}
                </div>
            })()}
            {residentCancellationRequest && <div className="resident-request-history-modal-backdrop" onMouseDown={(event) => {
              if (event.target === event.currentTarget) {
                setResidentCancellationRequestId('')
                setCancellationGcashError('')
              }
            }}>
              <form className="resident-request-history-modal resident-cancellation-modal" role="dialog" aria-modal="true" aria-labelledby="resident-cancellation-title" onSubmit={submitResidentRequestCancellation}>
                <header>
                  <div><span className="section-number">CANCEL REQUEST</span><h2 id="resident-cancellation-title">{residentCancellationRequest.documents?.join(' · ') || 'Document request'}</h2><p>{residentCancellationRequest.id}</p></div>
                  <button type="button" aria-label="Close cancellation" onClick={() => { setResidentCancellationRequestId(''); setCancellationGcashError('') }}>×</button>
                </header>
                <div className="resident-cancellation-content">
                  <p>{residentCancellationRequest.paymentStatus === 'Paid'
                    ? `This request has a recorded payment of ₱${Number(residentCancellationRequest.feeAmount || 0).toFixed(2)}. Enter your GCash number so the barangay can follow up about a possible refund.`
                    : `Your payment proof is still awaiting verification. If the payment is confirmed, the barangay can follow up about a refund using your GCash number.`}</p>
                  <p className="resident-cancellation-refund-note">The refund is not automatic. The barangay must verify the payment and process any refund manually. Only this request’s fee of ₱{Number(residentCancellationRequest.feeAmount || 0).toFixed(2)} is considered; other requests are not cancelled.</p>
                  <label htmlFor="resident-cancellation-gcash-number">Your GCash mobile number</label>
                  <input id="resident-cancellation-gcash-number" type="tel" value={cancellationGcashNumber} onChange={(event) => { setCancellationGcashNumber(event.target.value); setCancellationGcashError('') }} placeholder="09XX XXX XXXX" maxLength={20} autoComplete="tel" required />
                  {cancellationGcashError && <p className="resident-cancellation-error" role="alert">{cancellationGcashError}</p>}
                  <div className="resident-cancellation-actions">
                    <button type="button" className="cancel-button" onClick={() => { setResidentCancellationRequestId(''); setCancellationGcashError('') }}>Keep request</button>
                    <button type="submit" className="resident-request-cancel-action">Cancel request</button>
                  </div>
                </div>
              </form>
            </div>}
              </>
            ) : residentDashboardSection === 'drafts-corrections' ? (
              <div className="resident-drafts-corrections-page">
                <header className="resident-drafts-heading">
                  <span className="resident-drafts-heading-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v6h5M10 13h6M10 17h6" /><path d="M4 6v15h3" /></svg>
                  </span>
                  <div><span className="section-number">REQUEST WORKSPACE</span><h2>Drafts, corrections &amp; cancelled</h2><p>Continue saved requests, resolve returned requests, or review cancellations.</p></div>
                </header>
                <div className="resident-drafts-workspace">
                <div className="resident-drafts-corrections-tabs" role="group" aria-label="Request workspace categories">
                  <button type="button" id="resident-drafts-tab-drafts" aria-pressed={residentDraftsCorrectionsTab === 'drafts'} aria-controls="resident-drafts-panel" className={residentDraftsCorrectionsTab === 'drafts' ? 'active' : ''} onClick={() => setResidentDraftsCorrectionsTab('drafts')}>
                    <span className="resident-drafts-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v6h5M10 13h6M10 17h4" /></svg></span>
                    <span className="resident-drafts-tab-copy"><strong>Drafts</strong><small>Continue saved requests</small></span>
                  </button>
                  <button type="button" id="resident-drafts-tab-corrections" aria-pressed={residentDraftsCorrectionsTab === 'corrections'} aria-controls="resident-drafts-panel" className={residentDraftsCorrectionsTab === 'corrections' ? 'active' : ''} onClick={() => { markResidentDashboardSectionRead('drafts-corrections', 'corrections'); setResidentDraftsCorrectionsTab('corrections') }}>
                    <span className="resident-drafts-tab-icon corrections" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v5M12 17.5h.01" /></svg></span>
                    <span className="resident-drafts-tab-copy"><strong>Corrections</strong><small>Resolve returned requests</small></span>
                    {residentCorrectionUnreadCount > 0 && <span className="resident-unread-update-count" aria-label={`${residentCorrectionUnreadCount} unread corrections`}>{residentCorrectionUnreadCount}</span>}
                  </button>
                  <button type="button" id="resident-drafts-tab-cancelled" aria-pressed={residentDraftsCorrectionsTab === 'cancelled'} aria-controls="resident-drafts-panel" className={residentDraftsCorrectionsTab === 'cancelled' ? 'active' : ''} onClick={() => { markResidentDashboardSectionRead('drafts-corrections', 'cancelled'); setResidentDraftsCorrectionsTab('cancelled') }}>
                    <span className="resident-drafts-tab-icon cancelled" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6m0-6-6 6" /></svg></span>
                    <span className="resident-drafts-tab-copy"><strong>Cancelled</strong><small>Requests you chose not to continue</small></span>
                    {residentCancelledUnreadCount > 0 && <span className="resident-unread-update-count" aria-label={`${residentCancelledUnreadCount} unread cancellations`}>{residentCancelledUnreadCount}</span>}
                  </button>
                </div>
                <div className="resident-drafts-content" id="resident-drafts-panel" role="region" aria-label={residentDraftsCorrectionsTab === 'drafts' ? 'Saved draft requests' : residentDraftsCorrectionsTab === 'corrections' ? 'Requests needing corrections' : 'Cancelled requests'}>
                {residentDraftsCorrectionsTab === 'cancelled' ? (
                  <section className="resident-workspace-panel resident-cancelled-section">
                    <div className="resident-cancelled-list">
                      {residentCancelledRequests.map((request) => {
                        const cancelledAt = request.cancelledAt ? new Date(request.cancelledAt) : null
                        const hasCancelledAt = cancelledAt && !Number.isNaN(cancelledAt.getTime())
                        const submittedAt = request.requestedAt ? new Date(request.requestedAt) : null
                        const hasSubmittedAt = submittedAt && !Number.isNaN(submittedAt.getTime())
                        const paymentGroup = residentPaymentRecords.find((payment) => payment.requestIds.includes(request.id))
                        const linkedPaymentRequests = paymentGroup?.requests || [request]
                        const sharedPayment = linkedPaymentRequests.length > 1
                        return <article className="resident-cancelled-card" key={request.id}>
                          <header className="resident-workspace-card-heading">
                            <div><span className="resident-inbox-request-id">CANCELLED REQUEST · {request.id}</span><h2>{request.documents?.join(' · ') || 'Document request'}</h2></div>
                            <span className="resident-status-badge cancelled">Cancelled</span>
                          </header>
                          <dl className="resident-cancelled-dates">
                            <div><dt>Submitted</dt><dd>{hasSubmittedAt ? submittedAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</dd></div>
                            <div><dt>Cancelled</dt><dd>{hasCancelledAt ? cancelledAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</dd></div>
                            {Number(request.feeAmount || 0) > 0 && <div><dt>Request fee</dt><dd>₱{Number(request.feeAmount || 0).toFixed(2)} · {request.paymentStatus || 'Unpaid'}</dd></div>}
                          </dl>
                          <p className="resident-cancelled-note">Cancelled before review; this request will not be processed.{request.paymentStatus === 'Paid' ? request.refundStatus === 'Refunded' ? ' The Barangay Hall recorded your refund below.' : ' The Barangay Hall will use the GCash number you provided to follow up on any refund.' : request.paymentStatus === 'Pending verification' ? ' The Barangay Hall will verify your submitted payment proof first, then use the GCash number you provided for any refund follow-up.' : Number(request.feeAmount || 0) > 0 ? ' This cancelled request is no longer included in your balance to pay.' : ''}{sharedPayment ? ` One proof covers ${linkedPaymentRequests.map((linkedRequest) => linkedRequest.documents?.join(' · ') || 'Document request').join('; ')} (₱${Number(paymentGroup.feeAmount || 0).toFixed(2)} total). Only this request’s ₱${Number(request.feeAmount || 0).toFixed(2)} fee is considered for refund; other request fees are tracked separately.` : ''}</p>
                          {Number(request.feeAmount || 0) > 0 && (request.paymentProof?.dataUrl || request.paymentProofOrNumber) && <div className="resident-cancelled-payment-evidence">
                            <strong>Original payment proof {sharedPayment ? '(shared with the listed requests)' : ''}</strong>
                            {request.paymentProof?.dataUrl
                              ? <a className="payment-proof-preview" href={request.paymentProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.paymentProof.dataUrl} alt={`Original payment proof for ${request.id}`} /><span>{request.paymentProof.fileName || 'View original payment proof'}</span></a>
                              : <span>Reference: {request.paymentProofOrNumber}</span>}
                          </div>}
                          {request.refundStatus === 'Refunded' && <section className="resident-refund-confirmation" aria-label="Refund details">
                            <strong>Refund recorded · ₱{Number(request.feeAmount || 0).toFixed(2)}</strong>
                            <span>Sent to {request.refundDestinationNumber || 'your contact number'} · {request.refundedAt ? new Date(request.refundedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'date not recorded'}</span>
                            {request.refundTransactionNumber && <span>GCash reference: {request.refundTransactionNumber}</span>}
                            {request.refundNote && <span>{request.refundNote}</span>}
                            {request.refundProof?.dataUrl && <a className="payment-proof-preview" href={request.refundProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.refundProof.dataUrl} alt={`Refund receipt for ${request.id}`} /><span>{request.refundProof.fileName || 'View refund proof'}</span></a>}
                          </section>}
                        </article>
                      })}
                      {!residentCancelledRequests.length && <div className="resident-inbox-no-requests"><h2>No cancelled requests</h2><p>Requests you cancel before review will be saved here.</p></div>}
                    </div>
                  </section>
                ) : residentDraftsCorrectionsTab === 'corrections' ? (
                  <section className="resident-workspace-panel resident-corrections-section">
                    <div className="resident-correction-list">
                      {residentCorrectionRequests.map((request) => (
                        <article className="resident-correction-card" key={request.id}>
                          <header className="resident-workspace-card-heading"><div><span className="resident-inbox-request-id">REQUEST · {request.id}</span><h2>{request.documents?.join(' · ') || 'Document request'}</h2></div><span className="resident-request-status-wrap"><span className="resident-status-badge returned-for-edits">Needs correction</span>{residentCorrectionUpdateItems.some((item) => item.requestId === request.id && isResidentUpdateUnread(item)) && <span className="resident-request-new-dot" role="img" aria-label="New correction update" title="New correction update" />}</span></header>
                          <p className="resident-correction-note"><strong>Secretary’s note</strong>{request.editRequestNote || 'Please replace the selected document with a clear, valid copy.'}</p>
                          <button type="button" className="resident-table-action" onClick={() => { markResidentRequestUpdatesRead(request.id); setSelectedInboxRequestId(request.id); setResidentDashboardSection('requests') }}>Open request details</button>
                        </article>
                      ))}
                      {!residentCorrectionRequests.length && <div className="resident-inbox-no-requests"><h2>No requests need correction</h2><p>If the barangay office returns a document, its required changes and a resubmission option will appear here.</p></div>}
                    </div>
                  </section>
                ) : (
                  <section className="resident-workspace-panel resident-drafts-section">
                    {residentDraftError && <p className="resident-draft-error" role="alert">{residentDraftError}</p>}
                    <div className="resident-drafts-list">
                      {residentRequestDrafts.map((draft) => <article className="resident-draft-card" key={draft.id}>
                        <header className="resident-workspace-card-heading"><div><span className="resident-inbox-request-id">SAVED DRAFT</span><h2>{draft.documents?.length ? draft.documents.join(' · ') : 'Document request'}</h2><p>Last saved {draft.updatedAt && !Number.isNaN(new Date(draft.updatedAt).getTime()) ? new Date(draft.updatedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</p></div><span className="resident-draft-status">Not submitted</span></header>
                        {draft.details?.purpose && <p className="resident-draft-purpose"><strong>Purpose:</strong> {draft.details.purpose}</p>}
                        <div className="resident-draft-actions"><button type="button" className="resident-table-action" onClick={() => resumeResidentDraft(draft)}>Continue request</button><button type="button" className="resident-draft-delete" onClick={() => deleteResidentDraft(draft.id)}>Delete draft</button></div>
                      </article>)}
                      {!residentRequestDrafts.length && <div className="resident-inbox-no-requests"><h2>No drafts yet</h2><p>Select a document and start a request. Unsubmitted changes will appear here.</p><button type="button" className="check-button" onClick={() => chooseResidentPath('request')}>Start a request</button></div>}
                    </div>
                  </section>
                )}
                </div>
                </div>
              </div>
            ) : residentDashboardSection === 'payments' ? (
              <section className="resident-dashboard-section resident-payments-section">
                <div className="resident-payment-panels">
                  <section className={`resident-payment-main-panel${paymentBatchOpen ? ' payment-method-active' : ''}`} aria-labelledby="resident-payment-main-title">
                    <header className="resident-payment-panel-heading">
                      <div><span className="section-number">PAYMENT DETAILS</span><h2 id="resident-payment-main-title">Amount to pay &amp; payment proof {residentPaymentUnreadCount > 0 && <span className="resident-unread-update-count" aria-label={`${residentPaymentUnreadCount} payment updates not yet viewed`}>{residentPaymentUnreadCount}</span>}</h2><p>Select one or more requests to pay now. Document processing starts after the office verifies payment.</p></div>
                      <div className="resident-payment-balance"><span>Balance to pay</span><strong>₱{residentPaymentBalance.toFixed(2)}</strong></div>
                    </header>
                    {!paymentBatchOpen ? (
                      <section className="resident-payment-selection" aria-labelledby="resident-payment-selection-title">
                        <div className="resident-payment-selection-heading">
                          <div><h3 id="resident-payment-selection-title">Choose requests to pay now</h3><p>Select one request or several. Unselected requests stay here unless you move them to Drafts.</p></div>
                          <div><button type="button" onClick={() => updatePaymentSelection(unpaidResidentPaymentRequests.map((request) => request.id))} disabled={!unpaidResidentPaymentRequests.length}>Select all</button><button type="button" className="resident-payment-delete-selected" onClick={deleteSelectedUnsubmittedPaymentRequests} disabled={!selectedResidentPaymentRequests.some((request) => request.awaitingPaymentSubmission)}>Delete selected</button><button type="button" onClick={() => updatePaymentSelection([])} disabled={!selectedPaymentRequestIds.length}>Clear selection</button></div>
                        </div>
                        <div className="resident-payment-selection-list">
                          {unpaidResidentPaymentRequests.map((request) => (
                            <article className="resident-payment-selection-item" key={request.id}>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={selectedPaymentRequestIds.includes(request.id)}
                                  onChange={() => togglePaymentRequestSelection(request.id)}
                                />
                                <span><strong>{request.documents?.join(' · ') || 'Document request'}</strong><small>{request.id} · {Number(request.copyCount) || 1} {Number(request.copyCount) === 1 ? 'copy' : 'copies'} · ₱{Number(request.feeAmount || 0).toFixed(2)}</small></span>
                              </label>
                              {request.awaitingPaymentSubmission && <button type="button" className="resident-payment-save-draft" onClick={() => movePaymentRequestToDraft(request)}>Save to Drafts</button>}
                            </article>
                          ))}
                          {!unpaidResidentPaymentRequests.length && <p className="resident-payment-selection-empty">{residentPaymentRequests.length ? 'No unpaid requests to select. Submitted proofs are being verified.' : 'Your unpaid requests will appear here.'}</p>}
                        </div>
                        <div className="resident-payment-selection-total">
                          <span>{selectedResidentPaymentRequests.length} selected</span>
                          <strong>Selected total · ₱{selectedResidentPaymentTotal.toFixed(2)}</strong>
                          <button type="button" className="resident-table-action" disabled={!selectedResidentPaymentRequests.length} onClick={() => {
                            setPaymentProof(null)
                            setPaymentProofOrNumber('')
                            setPaymentProofError('')
                            setPaymentMethod('')
                            setWalkInPaymentNoticeOpen(false)
                            setPaymentBatchOpen(true)
                          }}>Continue to payment</button>
                        </div>
                      </section>
                    ) : (
                      <section className="resident-payment-method-step" aria-labelledby="resident-payment-method-title">
                        <header><div><h3 id="resident-payment-method-title">Choose payment method</h3><p>{selectedResidentPaymentRequests.length} request{selectedResidentPaymentRequests.length === 1 ? '' : 's'} · ₱{selectedResidentPaymentTotal.toFixed(2)} total</p></div><button type="button" className="resident-payment-back-button" onClick={() => { setPaymentBatchOpen(false); setPaymentMethod(''); setWalkInPaymentNoticeOpen(false); setPaymentProof(null); setPaymentProofOrNumber(''); setPaymentProofError('') }}>Back to requests</button></header>
                        {hasStalePaymentSelection
                          ? <div className="resident-payment-pending" role="alert"><strong>Payment selection changed</strong><span>One or more selected requests were updated in another tab. Review the unpaid requests before continuing.</span><button type="button" className="resident-table-action" onClick={() => updatePaymentSelection([])}>Review unpaid requests</button></div>
                          : <>
                        <fieldset className="resident-payment-method-options">
                          <legend>Payment options</legend>
                          <button type="button" className="resident-payment-method-option walk-in-payment-note" aria-haspopup="dialog" onClick={() => setWalkInPaymentNoticeOpen(true)}><span className="resident-payment-method-note-icon" aria-hidden="true">i</span><span><strong>Walk-in at Barangay Hall</strong><small>Visit the cashier in person. Click for details.</small></span></button>
                          <label className="resident-payment-method-option"><input type="radio" name="payment-method-batch" value="gcash" checked={paymentMethod === 'gcash'} onChange={() => { setPaymentMethod('gcash'); setWalkInPaymentNoticeOpen(false); setPaymentProof(null); setPaymentProofOrNumber(''); setPaymentProofError('') }} /><span><strong>GCash transfer</strong><small>Send from the GCash app; this system does not collect your login, PIN, or OTP.</small></span></label>
                        </fieldset>
                        {paymentMethod === 'gcash' && <form className="resident-payment-form resident-payment-batch-form" onSubmit={(event) => submitPaymentProof(event, selectedResidentPaymentRequests)}>
                          <GcashTransferInstructions amount={selectedResidentPaymentTotal} recipients={gcashRecipients} />
                          <label>Receipt image <span>(optional if you enter an OR/transaction number)</span><input type="file" accept="image/*" onChange={handlePaymentProofChange} /></label>
                          {paymentProofLoading && <small>Preparing receipt image…</small>}
                          {paymentProof && <small>{paymentProof.fileName}</small>}
                          <label>OR/transaction number <span>(optional if you upload a receipt)</span><input value={paymentProofOrNumber} onChange={(event) => setPaymentProofOrNumber(event.target.value)} placeholder="GCash reference or official receipt number" /></label>
                          {paymentProofError && <p className="community-update-error" role="alert">{paymentProofError}</p>}
                          <div><button type="submit" className="resident-table-action" disabled={paymentProofLoading}>Send proof &amp; request for {selectedResidentPaymentRequests.length} request{selectedResidentPaymentRequests.length === 1 ? '' : 's'}</button></div>
                        </form>}
                          </>}
                      </section>
                    )}
                    {walkInPaymentNoticeOpen && <div className="resident-payment-notice-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setWalkInPaymentNoticeOpen(false) }}>
                      <section className="resident-payment-notice" role="dialog" aria-modal="true" aria-labelledby="resident-walk-in-notice-title">
                        <span className="resident-payment-notice-icon" aria-hidden="true">!</span>
                        <p className="section-number">WALK-IN PAYMENT</p>
                        <h3 id="resident-walk-in-notice-title">Sorry, this request cannot continue online.</h3>
                        <p>Please visit the Barangay Hall to pay at the cashier and complete the document process in person. The documents will not be generated or sent for processing from this screen. Your unpaid requests remain in Payment Tracking.</p>
                        <button type="button" className="resident-table-action" onClick={() => setWalkInPaymentNoticeOpen(false)}>I understand</button>
                      </section>
                    </div>}
                    {paymentSaveConfirmation && <div className="resident-payment-save-confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setPaymentSaveConfirmation(null) }}>
                      <section className="resident-payment-save-confirmation" role="dialog" aria-modal="true" aria-labelledby="resident-payment-save-confirmation-title">
                        <span className="resident-payment-save-confirmation-icon" aria-hidden="true">✓</span>
                        <p className="section-number">CONFIRM PAYMENT SUBMISSION</p>
                        <h2 id="resident-payment-save-confirmation-title">Save this request?</h2>
                        <p>Saving adds these requests to My Requests as pending payment verification. Document processing starts after the office verifies your payment.</p>
                        <dl>
                          <div><dt>Requests</dt><dd>{paymentSaveConfirmation.flatMap((request) => request.documents || []).join(' · ') || `${paymentSaveConfirmation.length} document request${paymentSaveConfirmation.length === 1 ? '' : 's'}`}</dd></div>
                          <div><dt>Total</dt><dd>₱{paymentSaveConfirmation.reduce((total, request) => total + Number(request.feeAmount || 0), 0).toFixed(2)}</dd></div>
                          <div><dt>Payment method</dt><dd>{paymentMethod === 'gcash' ? 'GCash transfer' : paymentMethod || 'Not selected'}</dd></div>
                          <div><dt>Payment proof</dt><dd>{paymentProofOrNumber.trim() || paymentProof?.fileName || 'Receipt image attached'}</dd></div>
                        </dl>
                        <div className="resident-payment-save-confirmation-actions">
                          <button type="button" className="resident-payment-back-button" onClick={() => setPaymentSaveConfirmation(null)}>Back to payment</button>
                          <button type="button" className="resident-payment-save-button" onClick={confirmPaymentProofSubmission}>Save request</button>
                        </div>
                      </section>
                    </div>}
                  </section>
                  <div className="resident-payment-side-panels">
                    <section className="resident-payment-records-panel" aria-labelledby="resident-payment-records-title">
                            <header><div><span className="section-number">PAYMENT RECORDS</span><h2 id="resident-payment-records-title">Your payments</h2><p>Review each payment, verification, cancellation, and any recorded refund.</p></div></header>
                      <div className="resident-payment-list">
                        {residentPaymentRecords.map((request) => {
                          const status = request.paymentStatus || 'Unpaid'
                          const linkedRequests = request.requests || [request]
                          const relatedPaymentUpdates = residentPaymentUpdateItems.filter((item) => (
                            linkedRequests.some((linkedRequest) => linkedRequest.id === item.requestId)
                          ))
                          const hasUnreadPaymentUpdate = relatedPaymentUpdates.some(isResidentUpdateUnread)
                          const cancelledRequests = linkedRequests.filter((linkedRequest) => linkedRequest.status === 'Cancelled')
                          const refundedAmount = linkedRequests
                            .filter((linkedRequest) => linkedRequest.refundStatus === 'Refunded')
                            .reduce((total, linkedRequest) => total + Number(linkedRequest.feeAmount || 0), 0)
                          const proofSubmittedAt = request.paymentSubmittedAt ? new Date(request.paymentSubmittedAt) : null
                          const hasProofSubmittedAt = proofSubmittedAt && !Number.isNaN(proofSubmittedAt.getTime())
                          return <details className={`resident-payment-record-item${request.awaitingPaymentSubmission ? ' awaiting-payment-submission' : ''}${hasUnreadPaymentUpdate ? ' has-unread-update' : ''}`} key={request.id} onToggle={(event) => {
                            if (event.currentTarget.open) {
                              markResidentUpdatesRead('payments', relatedPaymentUpdates.map((item) => item.id))
                            }
                          }}>
                            <summary className="resident-payment-record-summary">
                              <span className="resident-payment-record-icon" aria-hidden="true"><ResidentDocumentIcon document={request.documents?.[0]} /></span>
                              <span className="resident-payment-record-copy"><strong>{request.documents?.join(' · ') || 'Document request'}</strong><small>{linkedRequests.length > 1 ? `${linkedRequests.length} requests · ${cancelledRequests.length} cancelled · ` : `${request.id} · `}{Number(request.copyCount) || 1} {(Number(request.copyCount) || 1) === 1 ? 'copy' : 'copies'} · ₱{Number(request.feeAmount || 0).toFixed(2)}{hasProofSubmittedAt ? ` · ${proofSubmittedAt.toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}` : ''}</small></span>
                              {hasUnreadPaymentUpdate
                                ? <span className="resident-request-new-dot" role="img" aria-label="New payment update" title="New payment update" />
                                : <span className="resident-payment-record-update-dot-placeholder" aria-hidden="true" />}
                              <span className={`resident-payment-status ${status.toLowerCase().replace(/\s+/g, '-')}`}>{request.awaitingPaymentSubmission ? 'Unpaid' : status}</span>
                              <span className="resident-payment-record-action">View</span>
                            </summary>
                            <div className="resident-payment-record-details">
                              {request.awaitingPaymentSubmission && <p className="resident-payment-draft-status">Not submitted yet · send payment proof to submit this request.</p>}
                              <section className="resident-payment-request-information">
                                <h3>Payment proof details</h3>
                                <dl>
                                  <div><dt>Name</dt><dd>{request.resident || 'Name not provided'}</dd></div>
                                  <div><dt>Address</dt><dd>{request.details?.address || 'Address not provided'}</dd></div>
                                  {linkedRequests.length > 1 && <div><dt>Shared payment proof</dt><dd>One proof covers {linkedRequests.length} requests · ₱{Number(request.feeAmount || 0).toFixed(2)} total</dd></div>}
                                </dl>
                                {(linkedRequests.length > 1 || cancelledRequests.length > 0 || refundedAmount > 0) && <div className="resident-payment-request-outcomes"><strong>{linkedRequests.length > 1 ? 'Per-request charges and status' : 'Request and refund status'}</strong>{linkedRequests.map((linkedRequest) => <div key={linkedRequest.id}><span>{linkedRequest.documents?.join(' · ') || 'Document request'} · ₱{Number(linkedRequest.feeAmount || 0).toFixed(2)}</span><small>{linkedRequest.status === 'Cancelled' ? `Cancelled${linkedRequest.cancelledAt ? ` · ${new Date(linkedRequest.cancelledAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })}` : ''}` : linkedRequest.status} · Payment: {linkedRequest.paymentStatus || 'Unpaid'}{linkedRequest.refundStatus === 'Refunded' ? ` · Refunded ₱${Number(linkedRequest.feeAmount || 0).toFixed(2)}${linkedRequest.refundedAt ? ` on ${new Date(linkedRequest.refundedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })}` : ''}` : ''}</small>{linkedRequest.refundStatus === 'Refunded' && <><small>{linkedRequest.refundDestinationNumber ? `Refund sent to ${linkedRequest.refundDestinationNumber}` : 'Refund destination not recorded'}{linkedRequest.refundTransactionNumber ? ` · GCash reference ${linkedRequest.refundTransactionNumber}` : ''}</small>{linkedRequest.refundProof?.dataUrl && <a className="payment-proof-preview" href={linkedRequest.refundProof.dataUrl} target="_blank" rel="noreferrer"><img src={linkedRequest.refundProof.dataUrl} alt={`Refund proof for ${linkedRequest.id}`} /><span>{linkedRequest.refundProof.fileName || 'View refund proof'}</span></a>}</>}</div>)}</div>}
                                <div className="resident-payment-proof-display">
                                  <strong>Payment proof</strong>
                                  {request.paymentProof?.dataUrl
                                    ? <a className="payment-proof-preview resident-payment-proof-preview" href={request.paymentProof.dataUrl} target="_blank" rel="noreferrer"><img src={request.paymentProof.dataUrl} alt={`Payment receipt for ${request.id}`} /><span>Open full-size receipt</span></a>
                                    : <span>{request.paymentProofOrNumber ? `Reference: ${request.paymentProofOrNumber}` : request.awaitingPaymentSubmission ? 'No proof submitted yet.' : 'No receipt image was submitted.'}</span>}
                                  {linkedRequests.length > 1 && <span>This proof is shared by the listed requests. Cancellation affects only the cancelled request’s fee.</span>}
                                </div>
                              </section>
                              {status === 'Paid' ? <p className="resident-payment-confirmed">Payment verified · ₱{Number(request.feeAmount || 0).toFixed(2)}{request.paymentOrNumber ? ` · OR No. ${request.paymentOrNumber}` : ''}{refundedAmount > 0 ? ` · Refund recorded ₱${refundedAmount.toFixed(2)} · Net expense ₱${Math.max(0, Number(request.feeAmount || 0) - refundedAmount).toFixed(2)}` : '.'}</p>
                                : status === 'Pending verification' ? <div className="resident-payment-pending" role="status"><strong>Payment proof received · Pending verification</strong><span>The office is verifying your payment. Document processing starts after payment is confirmed.</span></div>
                                  : <button type="button" className="resident-table-action" onClick={() => {
                                    updatePaymentSelection([request.id])
                                    setPaymentMethod('')
                                    setWalkInPaymentNoticeOpen(false)
                                    setPaymentBatchOpen(true)
                                  }}>Choose payment method</button>}
                            </div>
                          </details>
                        })}
                        {!residentPaymentRequests.length && <div className="resident-inbox-no-requests"><h2>No payment requests yet</h2><p>Requests with a payment due or proof submitted will appear here. They are sent to the barangay office after you submit payment proof.</p><button type="button" className="check-button" onClick={() => setResidentDashboardSection('request-documents')}>Request a document</button></div>}
                      </div>
                    </section>
                    <aside className="resident-payment-info-panel" aria-labelledby="resident-payment-info-title">
                    <span className="section-number">IMPORTANT INFORMATION</span>
                    <h2 id="resident-payment-info-title">Before you submit proof</h2>
                    <p>Use these checks to help the office verify your payment quickly.</p>
                    <ol>
                      <li><strong>Confirm the amount.</strong><span>Check the fee shown beside the correct document request before paying.</span></li>
                      <li><strong>Provide one proof option.</strong><span>Upload a clear receipt image or enter the OR/transaction number. You do not need both.</span></li>
                      <li><strong>Wait for verification.</strong><span>Your status changes to Pending verification after submission. The office will update it after review.</span></li>
                    </ol>
                    <div className="resident-payment-security-note"><strong>Keep your account safe</strong><span>Never share your payment PIN, password, or one-time passcode as payment proof.</span></div>
                  </aside>
                  </div>
                <section className="payment-history-section resident-payment-history-section" aria-labelledby="resident-payment-history-title">
                  <header className="admin-panel-heading">
                    <div>
                      <span className="section-number">RESIDENT PAYMENTS</span>
                      <h3 id="resident-payment-history-title">Payment history</h3>
                      <p>Review payment dates, transaction references, statuses, and recorded refunds.</p>
                    </div>
                    <span className="admin-panel-count">{residentPaymentHistoryRequests.length} records</span>
                  </header>
                  <TableSearch label="resident payment history"><div className="table-scroll">
                    <table className="admin-table payment-history-table">
                      <thead><tr><th>Date</th><th>Request</th><th>Amount</th><th>Payment method</th><th>Reference</th><th>Status</th></tr></thead>
                      <tbody>
                        {residentPaymentHistoryRequests.map((payment) => {
                          const paymentDateValue = payment.paymentSubmittedAt
                            || payment.paymentVerifiedAt
                            || payment.paymentDraftedAt
                            || payment.requestedAt
                          const paymentDate = paymentDateValue && !Number.isNaN(new Date(paymentDateValue).getTime())
                            ? new Date(paymentDateValue).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })
                            : 'Not recorded'
                          const paymentStatus = payment.paymentStatus || 'Paid'
                          const paymentStatusNotes = [
                            payment.status === 'Cancelled' ? 'Request cancelled' : '',
                            payment.refundStatus === 'Refunded' ? `Refunded ₱${Number(payment.feeAmount || 0).toFixed(2)}` : '',
                          ].filter(Boolean).join(' · ')
                          return <tr key={payment.id}>
                            <td>{paymentDate}</td>
                            <td className="payment-history-request-cell"><strong>{payment.documents?.join(' · ') || 'Document request'}</strong><small>{payment.id}</small></td>
                            <td>₱{Number(payment.feeAmount || 0).toFixed(2)}</td>
                            <td>{payment.paymentMethod === 'gcash' ? 'GCash transfer' : payment.paymentMethod === 'walk-in' ? 'Walk-in' : 'Not recorded'}</td>
                            <td>{payment.paymentOrNumber || payment.paymentProofOrNumber || 'Not recorded'}</td>
                            <td className="payment-history-status-cell">
                              <span className={`compliance-status ${paymentStatus.toLowerCase().replace(/\s+/g, '-')}`}>{paymentStatus}</span>
                              {paymentStatusNotes && <small>{paymentStatusNotes}</small>}
                            </td>
                          </tr>
                        })}
                        {!residentPaymentHistoryRequests.length && <tr><td colSpan="6">No paid documents in your history yet.</td></tr>}
                      </tbody>
                    </table>
                  </div></TableSearch>
                </section>
                </div>
              </section>
            ) : residentDashboardSection === 'history' ? (
              <section className="resident-dashboard-section resident-request-history-section">
                <header className="resident-request-history-heading">
                  <div><span className="section-number">REQUEST ARCHIVE</span><h2>Request History</h2><p>Review past requests, their final status, and processing timeline.</p></div>
                  <span className="admin-panel-count">{residentHistoryRequests.length} records</span>
                </header>
                <TableSearch label="resident request history"><div className="resident-history-table-wrap">
                  <table className="resident-history-table resident-request-history-table">
                    <thead><tr><th>Submitted</th><th>Request ID</th><th>Documents requested</th><th>Final status</th><th>Final date</th><th>Updates</th><th>Timeline</th></tr></thead>
                    <tbody>
                      {residentHistoryRequests.map((request) => {
                        const submittedAt = request.requestedAt && !Number.isNaN(new Date(request.requestedAt).getTime())
                          ? new Date(request.requestedAt).toLocaleDateString('en-PH', { dateStyle: 'medium' })
                          : request.date || 'Not recorded'
                        const finalTimestamp = getResidentRequestCompletionDate(request)
                        const finalDate = finalTimestamp && !Number.isNaN(new Date(finalTimestamp).getTime())
                          ? new Date(finalTimestamp).toLocaleDateString('en-PH', { dateStyle: 'medium' })
                          : 'Not recorded'
                        const unreadHistoryUpdates = residentHistoryUpdateItems.filter((item) => item.requestId === request.id && isResidentUpdateUnread(item))
                        return <tr key={request.id}>
                          <td data-label="Submitted">{submittedAt}</td>
                          <td data-label="Request ID"><strong>{request.id}</strong>{unreadHistoryUpdates.length > 0 && <span className="resident-request-new-dot" role="img" aria-label="New history update" title="New history update" />}</td>
                          <td data-label="Documents requested"><div className="resident-history-document-tags">{(request.documents || []).map((document) => <span key={document}>{document}</span>)}</div></td>
                          <td data-label="Final status"><span className={`resident-status-badge ${request.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{residentStatusLabels[request.status] || request.status}</span></td>
                          <td data-label="Final date">{finalDate}</td>
                          <td data-label="Updates">{request.activity?.length || 0}</td>
                          <td data-label="Timeline"><button type="button" className="resident-request-history-view" onClick={() => { markResidentUpdatesRead('history', residentHistoryUpdateItems.filter((item) => item.requestId === request.id).map((item) => item.id)); setSelectedFinishedCertificate(null); setSelectedResidentHistoryRequestId(request.id) }}>View timeline <span aria-hidden="true">→</span></button></td>
                        </tr>
                      })}
                      {!residentHistoryRequests.length && <tr><td className="resident-table-empty" colSpan="7">Completed, declined, and cancelled requests will appear here. Active requests remain in My Requests.</td></tr>}
                    </tbody>
                  </table>
                </div></TableSearch>
                {selectedResidentHistoryRequest && <div className="resident-request-history-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) { setSelectedResidentHistoryRequestId(null); setSelectedFinishedCertificate(null) } }}>
                  <section className="resident-request-history-modal" role="dialog" aria-modal="true" aria-labelledby="resident-request-history-title">
                    <header><div><span className="section-number">REQUEST PROCESS</span><h2 id="resident-request-history-title">{(selectedResidentHistoryRequest.documents || []).join(' · ')}</h2><p>{selectedResidentHistoryRequest.id}</p></div><button type="button" aria-label="Close request history" onClick={() => { setSelectedResidentHistoryRequestId(null); setSelectedFinishedCertificate(null) }}>×</button></header>
                    <div className="resident-request-history-modal-content">
                      <div className="resident-request-history-dates"><div><span>Request date</span><strong>{selectedResidentHistoryRequest.requestedAt && !Number.isNaN(new Date(selectedResidentHistoryRequest.requestedAt).getTime()) ? new Date(selectedResidentHistoryRequest.requestedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : selectedResidentHistoryRequest.date || 'Not recorded'}</strong></div><div><span>{['Completed', 'Released'].includes(selectedResidentHistoryRequest.status) ? 'Release date' : selectedResidentHistoryRequest.status === 'Cancelled' ? 'Cancellation date' : 'Decision date'}</span><strong>{getResidentRequestCompletionDate(selectedResidentHistoryRequest) && !Number.isNaN(new Date(getResidentRequestCompletionDate(selectedResidentHistoryRequest)).getTime()) ? new Date(getResidentRequestCompletionDate(selectedResidentHistoryRequest)).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded'}</strong></div><div><span>Purpose</span><strong>{selectedResidentHistoryRequest.details?.purpose || 'Not provided'}</strong></div></div>
                      <section><h3>Status timeline</h3><RequestTrackingTimeline request={selectedResidentHistoryRequest} /></section>
                      <section><h3>Processing activity</h3>{selectedResidentHistoryRequest.activity?.length ? <ol className="resident-request-history-activity">{selectedResidentHistoryRequest.activity.map((activity, index) => <li key={`${activity.time}-${index}`}><strong>{activity.action}</strong><span>{activity.by} · {activity.time || 'Date not recorded'}</span></li>)}</ol> : <p className="resident-profile-note">No additional processing notes were recorded.</p>}</section>
                    </div>
                  </section>
                </div>}
              </section>
            ) : residentDashboardSection === 'updates' ? (
              <section className="resident-dashboard-section">
                <div className="resident-document-updates">
                  {residentInboxRequests.slice().sort((first, second) => new Date(second.requestedAt || second.date).getTime() - new Date(first.requestedAt || first.date).getTime()).map((request) => {
                    const latestActivity = (request.activity || []).slice(-1)[0]
                    const statusLabel = residentStatusLabels[request.status] || request.status
                    return <article className="resident-document-update-card" key={request.id}>
                      <div className="resident-document-update-heading">
                        <div><p className="resident-inbox-request-id">{request.id} · Submitted {request.requestedAt ? new Date(request.requestedAt).toLocaleDateString('en-US', { dateStyle: 'medium' }) : request.date}</p><h2>{request.documents.join(' · ')}</h2></div>
                        <span className={`resident-status-badge ${request.status.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{statusLabel}</span>
                      </div>
                      <RequestTrackingTimeline request={request} />
                      {latestActivity && <div className="resident-document-latest-update"><strong>Latest update from {latestActivity.by}</strong><span>{latestActivity.action}</span><time>{latestActivity.time || 'Date not recorded'}</time></div>}
                      {request.pickupDate && <p className="resident-pickup-notice">Pickup schedule: <strong>{formatPickupSchedule(request.pickupDate, request.pickupTime)}</strong>{request.pickupInstructions && <span>{request.pickupInstructions}</span>}</p>}
                      {request.status === 'Returned for edits' && request.editRequestNote && <p className="resident-document-update-note"><strong>Action needed:</strong> {request.editRequestNote}</p>}
                      {request.declineReason && <p className="resident-document-update-note"><strong>Request declined:</strong> {request.declineReason}</p>}
                      <button type="button" className="resident-document-update-action" onClick={() => { markResidentRequestUpdatesRead(request.id); setResidentDashboardSection('requests'); setSelectedInboxRequestId(request.id) }}>Open request details <span aria-hidden="true">→</span></button>
                    </article>
                  })}
                  {!residentInboxRequests.length && <div className="resident-inbox-no-requests"><h2>No document updates yet</h2><p>After you submit a request, its current stage and any pickup details will appear here.</p><button type="button" className="check-button" onClick={() => chooseResidentPath('request')}>Start a document request</button></div>}
                </div>
              </section>
            ) : residentDashboardSection === 'community' ? (
              <section className="resident-dashboard-section resident-community-section">
                {registrationCommunityOnlyAccess && registrationReferenceNotice && ['approved', 'pending', 'paused', 'declined'].includes(registrationReferenceNotice.kind) && <div className="registration-reference-modal-backdrop">
                  <section className={`registration-reference-dialog ${registrationReferenceNotice.kind}`} role="dialog" aria-modal="true" aria-labelledby="registration-reference-dialog-title" aria-describedby="registration-reference-dialog-message" tabIndex="-1" onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      if (registrationReferenceNotice.kind === 'declined') acknowledgeRegistrationReferenceNotice()
                      else if (registrationReferenceNotice.kind === 'approved') returnApprovedReferenceToLogin()
                      else setRegistrationReferenceNotice(null)
                    }
                  }}>
                    <button type="button" className="registration-reference-dialog-close" aria-label={registrationReferenceNotice.kind === 'declined' ? 'Acknowledge note and close account' : registrationReferenceNotice.kind === 'approved' ? 'Log out and return to resident login' : 'Close application status message'} autoFocus onClick={() => {
                      if (registrationReferenceNotice.kind === 'declined') acknowledgeRegistrationReferenceNotice()
                      else if (registrationReferenceNotice.kind === 'approved') returnApprovedReferenceToLogin()
                      else setRegistrationReferenceNotice(null)
                    }}>×</button>
                    <p className="section-number">{registrationReferenceNotice.kind === 'approved'
                      ? 'REGISTRATION APPROVED'
                      : registrationReferenceNotice.kind === 'declined'
                        ? 'REGISTRATION DECISION'
                        : registrationReferenceNotice.kind === 'paused'
                          ? 'ACTION REQUIRED'
                          : 'REGISTRATION STATUS'}</p>
                    <h2 id="registration-reference-dialog-title">{registrationReferenceNotice.kind === 'approved'
                      ? 'Your account is ready'
                      : registrationReferenceNotice.kind === 'declined'
                        ? 'Sorry, your registration was not approved'
                        : registrationReferenceNotice.kind === 'paused'
                          ? 'Your application is paused'
                          : 'Your application is pending'}</h2>
                    <div className={`registration-reference-dialog-note${registrationReferenceNotice.kind === 'paused' ? ' is-paused-note' : ''}${registrationReferenceNotice.kind === 'declined' ? ' is-declined-note' : ''}`} id="registration-reference-dialog-message">
                      {registrationReferenceNotice.kind === 'paused' && <strong>Important — note from the barangay</strong>}
                      {registrationReferenceNotice.kind === 'declined' && <strong>Note from the barangay</strong>}
                      <p>{registrationReferenceNotice.message}</p>
                      {registrationReferenceNotice.kind === 'declined' && <small>Read the note carefully. Contact the barangay office if you need help understanding the decision or have questions about your application.</small>}
                    </div>
                    {registrationReferenceNotice.kind === 'approved' && registrationReferenceNotice.code && <div className="resident-assigned-code"><span>Resident code for full access</span><strong>{registrationReferenceNotice.code}</strong><small>Keep this code and enter it on the Resident Login form to access your account.</small></div>}
                    {registrationSubmitError && <p className="registration-edit-error" role="alert">{registrationSubmitError}</p>}
                    <div className="registration-reference-dialog-actions">
                    {['pending', 'paused'].includes(registrationReferenceNotice.kind)
                      && registrationRequests.find((request) => request.id === registrationReferenceNotice.requestId)?.status === 'Pending'
                      && <button type="button" className="registration-reference-dialog-edit" onClick={() => openMyRegistrationEditor(registrationReferenceNotice.requestId)}>My Registration</button>}
                    <button type="button" className="registration-reference-dialog-continue" onClick={() => {
                      if (registrationReferenceNotice.kind === 'declined') acknowledgeRegistrationReferenceNotice()
                      else if (registrationReferenceNotice.kind === 'approved') returnApprovedReferenceToLogin()
                      else setRegistrationReferenceNotice(null)
                    }}>{registrationReferenceNotice.kind === 'declined' ? 'Acknowledge and close account' : registrationReferenceNotice.kind === 'approved' ? 'Continue to Resident Login' : 'Continue to Community'}</button>
                    </div>
                  </section>
                </div>}
                {!isPublicCommunityConnected && <p className="resident-community-sync-warning" role="status">Showing locally saved announcements, events, and official details; live updates are unavailable right now.</p>}
                <div className="resident-community-tabs" role="group" aria-label="Community categories">
                  <button type="button" id="resident-community-tab-announcements" aria-pressed={residentCommunityTab === 'announcements'} aria-controls="resident-community-panel" className={residentCommunityTab === 'announcements' ? 'active' : ''} onClick={() => setResidentCommunityTab('announcements')}>
                    <span className="resident-community-tab-icon" aria-hidden="true">▦</span><span><strong>Announcements &amp; Events</strong><small>News, notices, and community calendar</small></span><span className="resident-community-tab-arrow" aria-hidden="true">›</span>
                  </button>
                  <button type="button" id="resident-community-tab-officials" aria-pressed={residentCommunityTab === 'officials'} aria-controls="resident-community-panel" className={residentCommunityTab === 'officials' ? 'active' : ''} onClick={() => setResidentCommunityTab('officials')}>
                    <span className="resident-community-tab-icon" aria-hidden="true">♙</span><span><strong>Barangay Officials</strong><small>Officials and office schedule</small></span><span className="resident-community-tab-arrow" aria-hidden="true">›</span>
                  </button>
                </div>
                <div className="resident-community-panel" id="resident-community-panel" role="region" aria-label={residentCommunityTab === 'announcements' ? 'Announcements and events' : 'Barangay officials'}>
                  {residentCommunityTab === 'announcements' ? (
                    <CommunityUpdatesCalendar
                      updates={communityUpdates}
                      isUpdateUnread={(update) => {
                        const notification = residentCommunityUpdateItems.find((item) => item.id === getResidentCommunityUpdateId(update))
                        return notification ? isResidentUpdateUnread(notification) : false
                      }}
                      onViewUpdate={(update) => {
                        markResidentUpdatesRead('community', [getResidentCommunityUpdateId(update)])
                      }}
                    />
                  ) : (
                    <section className="resident-readonly-officials resident-officials-page" aria-labelledby="resident-officials-title">
                      <header className="resident-readonly-officials-heading">
                        <div><span className="section-number">BARANGAY LEADERSHIP</span><h2 id="resident-officials-title">Barangay Officials</h2><p>Official details are maintained by the barangay administration.</p></div>
                        <span className="resident-readonly-officials-icon" aria-hidden="true">♙</span>
                      </header>
                      <ResidentLiveOfficeSchedule schedule={officialAvailability.find((official) => official.id === 'secretary')} todayDateKey={todayDateInput} />
                      <div className="resident-readonly-officials-grid">
                        {officialProfiles.map((official, index) => {
                          const enteredName = official.name?.trim()
                          const name = enteredName && !/^name to be updated$/i.test(enteredName) ? enteredName : 'Official name not set'
                          const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
                          const { days, hours } = getOfficialScheduleDetails(index)
                          const availability = getOfficialAvailabilityStatus(index)
                          return <article className="resident-readonly-official-card" key={`${official.role}-${index}`}>
                            <header className="resident-readonly-official-header">
                              <span className="resident-readonly-official-photo">
                                {officialPhotos[index] ? <img src={officialPhotos[index]} alt={`${name} portrait`} /> : <span aria-hidden="true">{initials}</span>}
                              </span>
                              <div className="resident-readonly-official-copy">
                                <span className="resident-readonly-official-role">{official.role || 'Barangay Official'}</span>
                                <h3>{name}</h3>
                              </div>
                              <span className={`official-availability-status${availability.isAvailable === true ? ' is-available' : availability.isAvailable === false ? ' is-unavailable' : ' is-not-set'}`} aria-label={`Availability: ${availability.label}`}>{availability.label}</span>
                            </header>
                            <div className="resident-readonly-official-note">
                              <span className="resident-readonly-official-detail-label">PROFILE</span>
                              <p>{official.description || 'No profile information added yet.'}</p>
                            </div>
                            <div className="resident-readonly-official-schedule" aria-label={`Schedule for ${official.role || 'barangay official'}`}>
                              <span>OFFICE SCHEDULE</span>
                              <div className="resident-readonly-official-schedule-details">
                                <small><b>Days</b>{days || 'Days not set'}</small>
                                <small><b>Hours</b>{hours || 'Time not set'}</small>
                              </div>
                            </div>
                          </article>
                        })}
                        {!officialProfiles.length && <p className="resident-readonly-officials-empty">Official profiles have not been set up yet.</p>}
                      </div>
                    </section>
                  )}
                </div>
              </section>
            ) : residentDashboardSection === 'pickup' ? (
              <section className="resident-dashboard-section resident-pickup-section">
                <header className="pickup-schedule-modal-header resident-pickup-page-header">
                  <div><span className="section-number">DOCUMENT COLLECTION</span><h3>Pickup schedule</h3><p>Review the schedule and instructions sent by the barangay.</p></div>
                  <div className="resident-pickup-heading-counts">
                    <span className="resident-pickup-count-chip"><strong>{residentPickupRequests.length}</strong> ready</span>
                    {residentPickupUnreadCount > 0 && <span className="resident-pickup-update-pill">{residentPickupUnreadCount} new {residentPickupUnreadCount === 1 ? 'update' : 'updates'}</span>}
                  </div>
                </header>
                <div className="resident-inbox-page-list resident-pickup-list">
                  {residentPickupRequests.map((request) => {
                    const pickupUpdates = residentPickupUpdateItems.filter((item) => item.requestId === request.id)
                    const unreadPickupUpdates = pickupUpdates.filter(isResidentUpdateUnread)
                    const latestPickupUpdate = pickupUpdates[0]
                    const requestLabel = `${request.documents?.join(' · ') || 'Document request'} · ${request.id}`
                    const pickupUpdateText = latestPickupUpdate?.description?.startsWith(`${requestLabel} · `)
                      ? latestPickupUpdate.description.slice(`${requestLabel} · `.length)
                      : latestPickupUpdate?.title || 'Your documents are ready for pickup.'
                    return <details
                      className={`resident-inbox-item resident-pickup-form-card${unreadPickupUpdates.length ? ' has-unread-update' : ''}`}
                      key={request.id}
                      onToggle={(event) => {
                        if (!event.currentTarget.open) return
                        markResidentUpdatesRead('pickup', pickupUpdates.map((item) => item.id))
                        markResidentRequestUpdatesRead(request.id)
                      }}
                    >
                      <summary className="resident-pickup-summary-toggle">
                        <header className="pickup-schedule-modal-header resident-pickup-card-header">
                          <div><span className="section-number">READY FOR RELEASE</span><h3>Pickup details</h3><p>{request.id}</p></div>
                          <div className="resident-pickup-card-status">
                            <span className="resident-status-badge ready-for-release">Ready for pickup</span>
                            {unreadPickupUpdates.length > 0 && <span className="resident-my-request-update-badge">{unreadPickupUpdates.length} new {unreadPickupUpdates.length === 1 ? 'update' : 'updates'}</span>}
                          </div>
                        </header>
                        <div className="pickup-request-summary resident-pickup-request-summary">
                          <div className="pickup-request-summary-icon" aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="M7 4.5h10a2 2 0 0 1 2 2v13H5v-13a2 2 0 0 1 2-2Z" /><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4" /></svg>
                          </div>
                          <div className="pickup-request-summary-item"><span>REQUEST REFERENCE</span><strong>{request.id}</strong></div>
                          <div className="pickup-request-summary-item"><span>DOCUMENTS</span><strong>{request.documents?.length || 0} {(request.documents?.length || 0) === 1 ? 'document' : 'documents'}</strong></div>
                        </div>
                        <div className="resident-pickup-expand-hint"><span>Click to view schedule and instructions</span><span className="resident-pickup-expand-icon" aria-hidden="true"><i /></span></div>
                      </summary>
                      <div className="resident-pickup-expanded-content">
                        <section className="ready-processing-documents resident-pickup-documents" aria-label="Documents ready for pickup">
                          <h4>Documents in this request</h4>
                          <ul>{(request.documents || []).map((document) => <li key={document}><span aria-hidden="true">✓</span>{document}</li>)}</ul>
                        </section>
                        <div className="resident-pickup-arrangement-label">COLLECTION ARRANGEMENT</div>
                        <dl className="pickup-review-details resident-pickup-review-details">
                          <div><dt>Pickup date</dt><dd>{formatPickupDate(request.pickupDate)}</dd></div>
                          <div><dt>Pickup time</dt><dd>{formatPickupTime(request.pickupTime)}</dd></div>
                          <div><dt>Pickup location &amp; instructions</dt><dd>{request.pickupInstructions || 'The barangay office will provide the pickup location and instructions.'}</dd></div>
                        </dl>
                        {latestPickupUpdate && <div className={`ready-processing-schedule resident-pickup-update${unreadPickupUpdates.length ? ' has-unread-update' : ''}`}>
                          <div className="ready-processing-schedule-heading"><span aria-hidden="true">{unreadPickupUpdates.length ? '!' : 'i'}</span><strong>{latestPickupUpdate.title}</strong></div>
                          <span className="resident-pickup-update-text">{pickupUpdateText}</span>
                          {latestPickupUpdate.time && <small>{latestPickupUpdate.time}</small>}
                        </div>}
                      </div>
                    </details>
                  })}
                  {!residentPickupRequests.length && <div className="resident-pickup-empty">
                    <span className="resident-pickup-empty-mark" aria-hidden="true">00</span>
                    <div><span className="resident-pickup-eyebrow">NOTHING TO COLLECT YET</span><h3>No documents ready for pickup</h3><p>When a request is approved and ready, its schedule and collection instructions will appear here.</p></div>
                    <button type="button" className="pickup-action-button resident-pickup-empty-action" onClick={() => setResidentDashboardSection('requests')}>
                      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5h10a2 2 0 0 1 2 2v13H5v-13a2 2 0 0 1 2-2Z" /><path d="M9 4.5V3h6v1.5M8.5 10h7M8.5 13.5h7M8.5 17h4" /></svg>
                      <span>Check my requests</span>
                      <span className="pickup-action-caption">See the latest request progress</span>
                    </button>
                  </div>}
                </div>
              </section>
            ) : residentDashboardSection === 'profile' ? (
              <section className="resident-dashboard-section resident-profile-section">
                {(() => {
                  const residentRecord = adminResidents.find((resident) => resident.code.toLowerCase() === residentName.code.trim().toLowerCase())
                  const registration = registrationInboxRequests[0]
                  const requestDetails = residentInboxRequests[0]?.details || {}
                  const profileDetails = registration?.data || {}
                  const residentProfileUpdates = residentProfileUpdateRequests
                    .filter((request) => request.residentCode?.toLowerCase() === residentName.code.trim().toLowerCase())
                    .sort((first, second) => new Date(second.submittedAt).getTime() - new Date(first.submittedAt).getTime())
                  const currentProfileValues = {
                    birthDate: residentRecord?.birthDate || residentRecord?.dateOfBirth || profileDetails.birthDate || requestDetails.birthDate || '',
                    contactNumber: residentRecord?.contactNumber || residentRecord?.mobileNumber || profileDetails.mobileNumber || requestDetails.contactNumber || '',
                    emailAddress: residentRecord?.emailAddress || profileDetails.emailAddress || '',
                    address: residentRecord?.address || requestDetails.address || registration?.address || '',
                  }
                  const residentCode = registration?.assignedResidentCode || residentRecord?.code || residentName.code || 'Not recorded'
                  const profileName = String(fullName || '').trim()
                  const initials = profileName.split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || 'R'
                  const profileGroups = [
                    {
                      title: 'Personal details',
                      icon: 'personal',
                      items: [['Date of birth', currentProfileValues.birthDate || 'Not provided']],
                    },
                    {
                      title: 'Contact & residence',
                      icon: 'residence',
                      items: [
                        ['Home address', currentProfileValues.address || 'Not provided'],
                        ['Contact number', currentProfileValues.contactNumber || 'Not provided'],
                        ['Email address', currentProfileValues.emailAddress || 'Not provided'],
                      ],
                    },
                  ]
                  return <>
                    <header className="resident-profile-hero">
                      <span className="resident-profile-avatar" aria-hidden="true">{initials}</span>
                      <div><h2>{profileName || 'Resident'}</h2><span>Resident ID · {residentCode}</span></div>
                      <span className="resident-profile-status"><i aria-hidden="true" /> Active</span>
                    </header>
                    <div className="resident-profile-details">
                      {profileGroups.map((group) => <section className="resident-profile-card" key={group.title}>
                        <h3><span className="resident-profile-card-icon" aria-hidden="true">
                          {group.icon === 'personal' ? <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="3.5" /><path d="M5 20c0-3.4 2.8-5.8 7-5.8s7 2.4 7 5.8" /></svg> : <svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7M5 9v11h14V9M9 20v-6h6v6" /></svg>}
                        </span>{group.title}</h3>
                        <dl>{group.items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
                      </section>)}
                    </div>
                    {renderResidentProfileUpdatePanel(currentProfileValues, residentProfileUpdates)}
                  </>
                })()}
              </section>
            ) : (
              <section className="resident-dashboard-section resident-dashboard-help">
                <article><h2>Barangay office</h2><p>Visit the Barangay Bagong Bayan 1 Hall and ask for the Barangay Secretary.</p><p>Processing hours: {officialAvailability.find((official) => official.id === 'secretary')?.hours || 'Please check the latest barangay schedule.'}</p></article>
                <article><h2>When contacting the office</h2><ul><li>Provide your full name and resident code.</li><li>Include your request reference number for document concerns.</li><li>For urgent public safety concerns, contact the appropriate local emergency service.</li></ul></article>
                <p className="resident-profile-note">No phone number or email address is currently listed in the system. Please visit the barangay office for assistance.</p>
              </section>
            )}
          </div>
          </main>
          </div>
          <footer className="resident-account-footer" aria-hidden="true" />
        </section>
      ) : showResidentOptions ? (
        <section className="resident-choice-page">
          <button type="button" className="back-button resident-choice-back" onClick={returnHome} aria-label="Back to home"><span aria-hidden="true">←</span><span className="sr-only">Back to home</span></button>
          <div className="resident-choice-panel">
            <div className="resident-choice-brand official-login-seal"><img src={barangaySeal} alt="" /></div>
            <h1 className="resident-choice-title">Resident Services</h1>
            <button type="button" className="resident-choice-button" onClick={() => chooseResidentPath('request')}>
              <span className="resident-choice-icon" aria-hidden="true">↗</span>
              <span><strong>Request</strong></span>
            </button>
            <button type="button" className="resident-choice-button" onClick={() => chooseResidentPath('registration')}>
              <span className="resident-choice-icon" aria-hidden="true">+</span>
              <span><strong>Registration</strong></span>
            </button>
          </div>
        </section>
      ) : showRegistrationForm ? (
        <section className={`registration-page${returnToRegistrationCommunity ? ' registration-page-redesign' : ''}`}>
          <form className={`registration-form${returnToRegistrationCommunity ? ' registration-form-redesign' : ''}`} onSubmit={submitRegistration}>
              <button type="button" className="official-login-back registration-back" onClick={() => {
                if (returnToRegistrationCommunity) {
                  if (editingRegistrationId) cancelRegistrationEdit()
                  returnToMyRegistrationSource()
                  return
                }
                if (editingRegistrationId) {
                  cancelRegistrationEdit()
                  return
                }
                setShowRegistrationForm(false)
                setShowResidentOptions(true)
              }} aria-label={returnToRegistrationCommunity ? 'Back to Community' : editingRegistrationId ? 'Cancel editing registration' : 'Back to resident services'}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg></button>
              <div className="registration-intro">
                <div className="official-login-seal registration-seal"><img src={barangaySeal} alt="" /></div>
                <div className="registration-heading"><p className="section-number">{editingRegistrationId ? 'UPDATE APPLICATION' : 'NEW RESIDENT'}</p><h1>Resident<br /><em>{editingRegistrationId ? 'My Registration' : 'Registration Form'}</em></h1><p className="intro-copy">{editingRegistrationId ? 'Update your application before the barangay records a decision. Your reference number will stay the same.' : 'Complete your information so the barangay can verify your residency.'}</p></div>
              </div>
              <button
                ref={registrationWalkInGuideTriggerRef}
                type="button"
                className="registration-walkin-trigger"
                aria-haspopup="dialog"
                aria-expanded={registrationWalkInGuideOpen}
                onClick={() => setRegistrationWalkInGuideOpen(true)}
              >
                <span className="registration-walkin-trigger-icon" aria-hidden="true">⌂</span>
                <span><strong>Planning to register in person?</strong><small>Open the walk-in checklist</small></span>
                <span className="registration-walkin-trigger-arrow" aria-hidden="true">↗</span>
              </button>
              {returnToRegistrationCommunity && <nav className="registration-section-nav" aria-label="Registration form sections">
                <a href="#registration-personal-section"><span>01</span><strong>Personal</strong></a>
                <a href="#registration-contact-section"><span>02</span><strong>Contact</strong></a>
                <a href="#registration-address-section"><span>03</span><strong>Address</strong></a>
                <a href="#registration-residency-section"><span>04</span><strong>Residency</strong></a>
                <a href="#registration-household-section"><span>05</span><strong>Household</strong></a>
                <a href="#registration-identification-section"><span>06</span><strong>Identification</strong></a>
                <a href="#registration-proof-section"><span>07</span><strong>Proof</strong></a>
              </nav>}
              {registrationReferenceDialogOpen && submittedRegistrationId && <div className="registration-reference-modal-backdrop">
                <section className="registration-reference-dialog pending registration-submitted-dialog" role="dialog" aria-modal="true" aria-labelledby="registration-submitted-title" aria-describedby="registration-submitted-message">
                  <div className="registration-submitted-icon" aria-hidden="true">✓</div>
                  <p className="section-number">APPLICATION RECEIVED</p>
                  <h2 id="registration-submitted-title">Your registration was submitted</h2>
                  <p className="registration-submitted-message" id="registration-submitted-message">Keep this reference number. Continue to Resident Login and enter it with your registered name to check your application status.</p>
                  <div className="registration-submitted-reference">
                    <span>YOUR APPLICATION REFERENCE</span>
                    <strong>{submittedRegistrationId}</strong>
                  </div>
                  {registrationStorageWarning && <p className="registration-submitted-warning" role="status">{registrationStorageWarning}</p>}
                  <button type="button" className="registration-reference-dialog-continue" onClick={() => {
                    setRegistrationReferenceDialogOpen(false)
                    setShowRegistrationForm(false)
                    setInboxAccessMode(false)
                    setShowResidentCheck(true)
                    setShowResidentInboxPage(false)
                    setResidentStatus('')
                    setResidentLoginError('')
                    setRegistrationReferenceNotice(null)
                  }}>Continue to Resident Login</button>
                </section>
              </div>}
              <fieldset id="registration-personal-section" className="registration-section" disabled={registrationSubmitted}>
                <legend>1. Personal Information</legend>
                <div className="registration-grid three-columns">
                  <div><label htmlFor="registration-first-name">First Name</label><input id="registration-first-name" value={registrationData.firstName} onChange={(event) => updateRegistrationField('firstName', event.target.value)} required /></div>
                  <div><label htmlFor="registration-middle-name">Middle Name <span>(optional)</span></label><input id="registration-middle-name" value={registrationData.middleName} onChange={(event) => updateRegistrationField('middleName', event.target.value)} /></div>
                  <div><label htmlFor="registration-last-name">Last Name</label><input id="registration-last-name" value={registrationData.lastName} onChange={(event) => updateRegistrationField('lastName', event.target.value)} required /></div>
                  <div><label htmlFor="registration-suffix">Suffix <span>(optional)</span></label><input id="registration-suffix" value={registrationData.suffix} onChange={(event) => updateRegistrationField('suffix', event.target.value)} placeholder="Jr., Sr., III" /></div>
                  <div><label htmlFor="registration-birth-date">Date of Birth</label><input id="registration-birth-date" type="date" value={registrationData.birthDate} onChange={(event) => updateRegistrationField('birthDate', event.target.value)} required /></div>
                  <div><label htmlFor="registration-place-birth">Place of Birth</label><input id="registration-place-birth" value={registrationData.placeOfBirth} onChange={(event) => updateRegistrationField('placeOfBirth', event.target.value)} required /></div>
                  <div><label htmlFor="registration-sex">Sex</label><select id="registration-sex" value={registrationData.sex} onChange={(event) => updateRegistrationField('sex', event.target.value)} required><option value="">Select sex</option><option>Female</option><option>Male</option><option>Prefer not to say</option></select></div>
                  <div><label htmlFor="registration-civil-status">Civil Status</label><select id="registration-civil-status" value={registrationData.civilStatus} onChange={(event) => updateRegistrationField('civilStatus', event.target.value)} required><option value="">Select status</option><option>Single</option><option>Married</option><option>Widowed</option><option>Separated</option></select></div>
                  <div><label htmlFor="registration-nationality">Nationality</label><input id="registration-nationality" value={registrationData.nationality} onChange={(event) => updateRegistrationField('nationality', event.target.value)} required /></div>
                </div>
              </fieldset>
              <fieldset id="registration-contact-section" className="registration-section" disabled={registrationSubmitted}>
                <legend>2. Contact Information</legend>
                <div className="registration-grid two-columns">
                  <div><label htmlFor="registration-mobile">Mobile Number</label><input id="registration-mobile" type="tel" value={registrationData.mobileNumber} onChange={(event) => updateRegistrationField('mobileNumber', event.target.value)} placeholder="09XX XXX XXXX" required /></div>
                  <div><label htmlFor="registration-email">Email Address <span>(optional)</span></label><input id="registration-email" type="email" value={registrationData.emailAddress} onChange={(event) => updateRegistrationField('emailAddress', event.target.value)} placeholder="you@example.com" /></div>
                </div>
              </fieldset>
              <fieldset id="registration-address-section" className="registration-section" disabled={registrationSubmitted}>
                <legend>3. Current Address</legend>
                <div className="registration-grid three-columns">
                  <div><label htmlFor="registration-street">Purok</label><input id="registration-street" value={registrationData.streetPurok} onChange={(event) => updateRegistrationField('streetPurok', event.target.value)} placeholder="e.g. Purok 3" required /></div>
                  <div><label htmlFor="registration-barangay">Barangay</label><input id="registration-barangay" value={registrationAddressDefaults.barangay} readOnly /></div>
                  <div><label htmlFor="registration-city">Municipality/City</label><input id="registration-city" value={registrationAddressDefaults.municipalityCity} readOnly /></div>
                  <div><label htmlFor="registration-province">Province</label><input id="registration-province" value={registrationAddressDefaults.province} readOnly /></div>
                  <div><label htmlFor="registration-stay">Years/Months of Stay</label><input id="registration-stay" value={registrationData.stayDuration} onChange={(event) => updateRegistrationField('stayDuration', event.target.value)} placeholder="e.g. 2 years" required /></div>
                </div>
              </fieldset>
              <fieldset id="registration-residency-section" className="registration-section" disabled={registrationSubmitted}>
                <legend>4. Residency Information</legend>
                <div className="radio-row"><span>Are you a new resident?</span><label><input type="radio" name="new-resident" checked={registrationData.newResident === 'yes'} onChange={() => updateRegistrationField('newResident', 'yes')} /> Yes</label><label><input type="radio" name="new-resident" checked={registrationData.newResident === 'no'} onChange={() => updateRegistrationField('newResident', 'no')} /> No</label></div>
                {registrationData.newResident === 'yes' && <div className="registration-grid two-columns conditional-fields">
                  <div><label htmlFor="registration-previous-address">Previous Address</label><input id="registration-previous-address" value={registrationData.previousAddress} onChange={(event) => updateRegistrationField('previousAddress', event.target.value)} required /></div>
                  <div><label htmlFor="registration-previous-barangay">Previous Barangay</label><input id="registration-previous-barangay" value={registrationData.previousBarangay} onChange={(event) => updateRegistrationField('previousBarangay', event.target.value)} required /></div>
                  <div><label htmlFor="registration-previous-city">Previous Municipality/City</label><input id="registration-previous-city" value={registrationData.previousMunicipalityCity} onChange={(event) => updateRegistrationField('previousMunicipalityCity', event.target.value)} required /></div>
                  <div><label htmlFor="registration-transfer-date">Date of Transfer</label><input id="registration-transfer-date" type="date" value={registrationData.dateOfTransfer} onChange={(event) => updateRegistrationField('dateOfTransfer', event.target.value)} required /></div>
                  <div className="full-width"><label htmlFor="registration-moving-reason">Reason for Moving</label><textarea id="registration-moving-reason" value={registrationData.reasonForMoving} onChange={(event) => updateRegistrationField('reasonForMoving', event.target.value)} required /></div>
                </div>}
              </fieldset>
              <fieldset id="registration-household-section" className="registration-section" disabled={registrationSubmitted}>
                <legend>5. Household Information</legend>
                <div className="radio-row"><span>Are you the Head of the Family?</span><label><input type="radio" name="household-head" checked={registrationData.householdHead === 'yes'} onChange={() => updateRegistrationField('householdHead', 'yes')} /> Yes</label><label><input type="radio" name="household-head" checked={registrationData.householdHead === 'no'} onChange={() => updateRegistrationField('householdHead', 'no')} /> No</label></div>
                <div className="registration-grid three-columns">
                  <div><label htmlFor="registration-head-name">Name of Household Head</label><input id="registration-head-name" value={registrationData.householdHeadName} onChange={(event) => updateRegistrationField('householdHeadName', event.target.value)} required /></div>
                  <div><label htmlFor="registration-members">Number of Household Members</label><input id="registration-members" type="number" min="1" value={registrationData.householdMembers} onChange={(event) => updateRegistrationField('householdMembers', event.target.value)} required /></div>
                  <div><label htmlFor="registration-relationship">Relationship to Household Head</label><input id="registration-relationship" value={registrationData.relationshipToHead} onChange={(event) => updateRegistrationField('relationshipToHead', event.target.value)} required /></div>
                </div>
              </fieldset>
              <fieldset id="registration-identification-section" className="registration-section" disabled={registrationSubmitted}>
                  <legend>6. Identification</legend>
                  <div className="registration-grid two-columns">
                    <div><label htmlFor="registration-id-type">Valid ID Type</label><select id="registration-id-type" value={registrationData.validIdType} onChange={(event) => updateRegistrationField('validIdType', event.target.value)} required><option value="">Select valid ID</option><option>National ID</option><option>Driver&apos;s License</option><option>Passport</option><option>PhilHealth ID</option><option>Other</option></select></div>
                    <div><label htmlFor="registration-id-number">ID Number</label><input id="registration-id-number" value={registrationData.idNumber} onChange={(event) => updateRegistrationField('idNumber', event.target.value)} required /></div>
                    <div className="full-width">
                      <label htmlFor="registration-valid-id">Upload Valid ID</label>
                      {editingRegistrationRequest?.files?.validId && <>
                        <RegistrationEvidencePreview evidence={editingRegistrationRequest.files.validId} label="Previously submitted valid ID" />
                        <small className="registration-current-evidence">Upload a new file below only if you want to replace the saved ID.</small>
                      </>}
                      <input id="registration-valid-id" type="file" accept="image/*,.pdf" onChange={(event) => { setRegistrationFiles({ ...registrationFiles, validId: event.target.files[0] || null }); setRegistrationSubmitError('') }} required={!editingRegistrationRequest?.files?.validId} />
                    </div>
                  </div>
              </fieldset>
              <fieldset id="registration-proof-section" className="registration-section" disabled={registrationSubmitted}>
                  <legend>7. Proof of Residence</legend>
                  <div className="proof-options">{['Lease/Rental Agreement', 'Utility Bill', 'Property/House Document', 'Certification from Property Owner', 'Other'].map((proofType) => <label key={proofType}><input type="checkbox" checked={(Array.isArray(registrationData.proofOfResidence) ? registrationData.proofOfResidence : []).includes(proofType)} onChange={(event) => toggleRegistrationProofType(proofType, event.target.checked)} />{proofType}</label>)}</div>
                  <div>
                    <label htmlFor="registration-proof">Upload Proof of Residence</label>
                    {editingRegistrationRequest?.files?.proofOfResidence && <>
                      <RegistrationEvidencePreview evidence={editingRegistrationRequest.files.proofOfResidence} label="Previously submitted proof of residence" />
                      <small className="registration-current-evidence">Upload a new file below only if you want to replace the saved proof.</small>
                    </>}
                    <input id="registration-proof" type="file" accept="image/*,.pdf" onChange={(event) => { setRegistrationFiles({ ...registrationFiles, proofOfResidence: event.target.files[0] || null }); setRegistrationSubmitError('') }} required={!editingRegistrationRequest?.files?.proofOfResidence} />
                  </div>
                  <small className="registration-evidence-upload-note">Uploaded files are saved for staff review. Images are compressed; PDFs must be 375 KB or smaller.</small>
              </fieldset>
              {registrationSubmitError && <p className="community-update-error" role="alert">{registrationSubmitError}</p>}
              {!registrationSubmitted && <div className="registration-actions">{editingRegistrationId && <button type="button" className="registration-editor-cancel" onClick={cancelRegistrationEdit}>Cancel</button>}<button type="submit" className="check-button" disabled={isSubmittingRegistration}>{isSubmittingRegistration ? (editingRegistrationId ? 'Saving changes…' : 'Saving application…') : editingRegistrationId ? 'Save changes' : 'Submit registration'}</button></div>}
              {registrationWalkInGuideOpen && <div className="registration-walkin-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeRegistrationWalkInGuide() }}>
                <section
                  className="registration-walkin-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="registration-walkin-title"
                  onKeyDown={(event) => { if (event.key === 'Escape') closeRegistrationWalkInGuide() }}
                >
                  <header className="registration-walkin-header">
                    <div>
                      <p className="section-number">BARANGAY BAGONG BAYAN 1 · WALK-IN GUIDE</p>
                      <h2 id="registration-walkin-title">What to bring when registering in person</h2>
                      <p>Bring the same supporting documents requested in this online form.</p>
                    </div>
                    <button type="button" className="registration-walkin-close" aria-label="Close walk-in checklist" autoFocus onClick={closeRegistrationWalkInGuide}>×</button>
                  </header>
                  <div className="registration-walkin-items">
                    <article>
                      <span className="registration-walkin-number">01</span>
                      <div><h3>A valid ID</h3><p>Bring your National ID, driver&apos;s license, passport, PhilHealth ID, or another valid ID.</p></div>
                    </article>
                    <article>
                      <span className="registration-walkin-number">02</span>
                      <div><h3>Proof of residence</h3><p>Bring one proof, such as a lease or rental agreement, utility bill, property or house document, certification from the property owner, or another document showing your address.</p></div>
                    </article>
                  </div>
                  <div className="registration-walkin-tip">
                    <strong>Prefer to finish online?</strong>
                    <p>Close this note and continue the form. Upload a clear photo or PDF of your ID and proof of residence; the proof type is selected in section 7.</p>
                  </div>
                  <footer className="registration-walkin-footer">
                    <span>You can return to this checklist anytime before submitting.</span>
                    <button type="button" className="check-button" onClick={closeRegistrationWalkInGuide}>Continue registration</button>
                  </footer>
                </section>
              </div>}
          </form>
        </section>
      ) : showResidentCheck ? (
        <section className={`resident-page${!inboxAccessMode ? ' resident-request-portal' : ''}${showRequestForm && !showReview ? ' request-details-page' : ''}${returnToResidentDashboardAfterRequest ? ' resident-dashboard-request-flow' : ''}${showRequestForm || showReview ? ' is-request-workflow' : ''}${showReview ? ' is-review-workflow' : ''}${showResidentCheck && !inboxAccessMode && !showRequestForm && !showReview && !showDocumentOptions ? ' resident-access-check' : ''}`}>
          {(returnToResidentDashboardAfterRequest || !inboxAccessMode) && !requestSubmitted && <div className="resident-request-workflow-header">
            {returnToResidentDashboardAfterRequest
              ? <button type="button" onClick={leaveRequestAsDraft}><span aria-hidden="true">←</span> Back to Request Documents</button>
              : <div className="resident-request-workflow-title">
                <img src={barangaySeal} alt="" />
                <span><small>BARANGAY BAGONG BAYAN 1</small><strong>Document request</strong><em>Secure resident services</em></span>
              </div>}
            <ol aria-label="Request steps">
              {(returnToResidentDashboardAfterRequest
                ? ['Choose documents', 'Request details', 'Review & submit']
                : ['Verify resident', 'Choose documents', 'Add details', 'Review request']
              ).map((step, index) => {
                const stepNumber = index + 1
                const activeStep = returnToResidentDashboardAfterRequest
                  ? showReview ? 3 : showRequestForm ? 2 : 1
                  : showReview ? 4 : showRequestForm ? 3 : showDocumentOptions ? 2 : 1
                return <li className={stepNumber === activeStep ? 'active' : stepNumber < activeStep ? 'complete' : ''} aria-current={stepNumber === activeStep ? 'step' : undefined} key={step}>
                  <span>{stepNumber}</span>{step}
                </li>
              })}
            </ol>
          </div>}
          {showReview ? (
            <>
              <div className="resident-heading review-heading">
                <div className="review-heading-icon" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none">
                    <path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.5-7 9-4.2-1.5-7-4.8-7-9V6l7-2.5Z" />
                    <path d="m9 12 2 2 4-4" />
                  </svg>
                </div>
                <div className="resident-review-title">
                  <p className="section-number">FINAL CHECK</p>
                  <h1>Review your<br /><em>request.</em></h1>
                  <p className="intro-copy">Confirm your document choices, information, and uploaded files before sending the request to barangay staff.</p>
                </div>
                <aside className="review-tips" aria-label="Tips for a smoother request">
                  <p><span aria-hidden="true">✓</span> Use the same name spelling shown on your valid ID.</p>
                  <p><span aria-hidden="true">✓</span> Make sure your selected documents and answers are correct.</p>
                  <p><span aria-hidden="true">✓</span> Upload clear, readable photos of your requirements.</p>
                  <small>You can still select “Edit details” to make changes before submitting.</small>
                </aside>
                <svg className="review-ornament" viewBox="0 0 360 112" fill="none" aria-hidden="true">
                  <path d="M14 85c42-38 78-38 113 0s71 38 107 0 71-38 112 0" />
                  <path d="M14 99c42-38 78-38 113 0s71 38 107 0 71-38 112 0" />
                  <circle cx="180" cy="33" r="19" />
                  <circle cx="180" cy="33" r="7" />
                  <path d="M180 3v9m0 42v9m30-30h-9m-42 0h-9m51-21-7 7m-30 30-7 7m44 0-7-7m-30-30-7-7" />
                  <circle cx="63" cy="44" r="4" />
                  <circle cx="297" cy="44" r="4" />
                </svg>
              </div>
              <div className="resident-form review-form">
                <div className="review-section">
                  <p className="review-section-heading"><span className="request-form-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.5" /></svg></span><span className="document-label">Review each document</span></p>
                  <div className="request-form-document-tabs review-document-tabs" role="tablist" aria-label="Select document to review">
                    {selectedDocuments.map((document, index) => (
                      <button
                        type="button"
                        className={`request-form-document-tab ${currentRequestDocument === document ? 'active' : ''}`}
                        role="tab"
                        id={`review-document-tab-${index}`}
                        aria-selected={currentRequestDocument === document}
                        aria-controls="review-document-tab-panel"
                        key={document}
                        onClick={() => setActiveRequestDocument(document)}
                      >
                        <ResidentDocumentIcon document={document} />
                        <span>{document}</span>
                      </button>
                    ))}
                  </div>
                  {(() => {
                    const document = currentRequestDocument
                    const fields = getCertificateTemplateFields(document, customCertificateTemplates)
                    const documentValues = getRequestCertificateValuesForDocument(document)
                    const copyCount = getDocumentCopyCount(document)
                    const subtotal = getDocumentFeeSubtotal(document)
                    const hasValidIdRequirement = getDocumentRequirements(document, customCertificateTemplates).includes('Valid government ID')
                    const philsysEvidence = requirementPhotos[philsysEvidencePhotoKey]
                    const photos = getDocumentRequirements(document, customCertificateTemplates)
                      .flatMap((requirement) => getRequirementPhotoKeys(requirement).flatMap((photoKey) => {
                        const photo = getAvailableRequirementPhoto(requirementPhotos, document, photoKey, selectedDocuments)
                        return photo ? [[getDocumentPhotoKey(document, photoKey), photo]] : []
                      }))
                    if (hasValidIdRequirement && philsysEvidence?.dataUrl) {
                      photos.push([`${document.replace(/\W+/g, '-').toLowerCase()}__philsys-verification`, philsysEvidence])
                    }
                    photos.sort(([firstKey], [secondKey]) => {
                      const getPhotoOrder = (key) => {
                        if (/valid-government-id-front$/.test(key)) return 0
                        if (/valid-government-id-back$/.test(key)) return 1
                        if (/philsys-verification$/.test(key)) return 2
                        return 4
                      }
                      return getPhotoOrder(firstKey) - getPhotoOrder(secondKey)
                    })
                    const reviewPhotos = photos.map(([photoKey, photo]) => ({
                      key: photoKey,
                      label: photoKey.endsWith('__philsys-verification')
                        ? 'PhilSys verification result'
                        : photoKey.split('__').slice(1).join(' ').replace(/-/g, ' '),
                      dataUrl: photo.dataUrl,
                      fileName: photo.fileName,
                    }))
                    return <section className="review-document-section" id="review-document-tab-panel" role="tabpanel" aria-labelledby={`review-document-tab-${selectedDocuments.indexOf(document)}`}>
                      <h3><ResidentDocumentIcon document={document} />{document}</h3>
                      <div className="review-document-content">
                        <div className="review-document-personal-details">
                          <dl className="review-document-copy-summary">
                            <div><dt>Number of copies</dt><dd>{copyCount ?? '—'} {copyCount === 1 ? 'copy' : 'copies'}</dd></div>
                            <div><dt>Subtotal</dt><dd>{subtotal === null ? '—' : `₱${subtotal.toFixed(2)}`}</dd></div>
                          </dl>
                          <h4>Personal details</h4>
                          <dl className="request-certificate-review-details">
                            {fields.map((field) => <div key={field.key}><dt>{field.label}</dt><dd>{formatCertificateReviewValue(documentValues[field.key])}</dd></div>)}
                            {!hasPurposeCertificateField(fields) && (
                              <div><dt>Purpose of request</dt><dd>{documentValues.purpose || 'Not provided'}</dd></div>
                            )}
                          </dl>
                        </div>
                        <div className="review-document-photo-details">
                          <h4>Requirement photos</h4>
                          <ResidentPhotoGallery
                            documentName={document}
                            photos={reviewPhotos}
                          />
                        </div>
                      </div>
                    </section>
                  })()}
                </div>
                <button type="button" className="check-button" disabled={Boolean(requirementPhotoError) || Object.values(requirementPhotoLoading).some(Boolean)} onClick={confirmRequest}>{selectedDocuments.some((document) => (getDocumentFeeSubtotal(document) || 0) > 0) ? 'Save paid request & continue to Payment Tracking' : 'Confirm and submit for official review'}</button>
                <button type="button" className="back-button" onClick={() => { setShowReview(false); setShowRequestForm(true) }}>Edit details</button>
              </div>
            </>
          ) : showRequestForm ? (
              <form className="resident-form request-form" onSubmit={submitRequest}>
                <header className="request-form-heading">
                  <span className="request-form-heading-icon" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M7 5h18v22H7zM11 11h10M11 16h10M11 21h6" /><path d="m20 23 2 2 5-6" /></svg></span>
                  <div><span className="section-number">APPLICATION · STEP {returnToResidentDashboardAfterRequest ? '2' : '3'}</span><h2>Request details</h2><p>Information and copy counts are saved per document. Shared requirements are uploaded once.</p></div>
                  <div className="request-form-document-tabs" role="tablist" aria-label="Select document to complete">
                    {selectedDocuments.map((document, index) => {
                      const requiredPhotoKeys = getCombinedDocumentRequirements([document], customCertificateTemplates)
                        .flatMap((requirement) => getRequirementPhotoKeys(requirement))
                      const photoCount = requiredPhotoKeys.filter((photoKey) => (
                        getAvailableRequirementPhoto(requirementPhotos, document, photoKey, selectedDocuments)
                      )).length
                      const photoTotal = requiredPhotoKeys.length
                      return <button type="button" className={`request-form-document-tab ${currentRequestDocument === document ? 'active' : ''}`} role="tab" id={`request-document-tab-${index}`} aria-selected={currentRequestDocument === document} aria-controls="request-document-tab-panel" key={document} onClick={() => { setActiveRequestDocument(document); setRequestDetailError('') }}>
                        <ResidentDocumentIcon document={document} /><span>{document}</span><small>{photoCount}/{photoTotal} photos</small>
                      </button>
                    })}
                  </div>
                </header>
                <section className="request-document-panel" id="request-document-tab-panel" role="tabpanel" aria-labelledby={`request-document-tab-${selectedDocuments.indexOf(currentRequestDocument)}`}>
                <div className="request-document-active-heading">
                  <ResidentDocumentIcon document={currentRequestDocument} />
                  <div><span>DOCUMENT DETAILS</span><strong>{currentRequestDocument}</strong><small>{selectedDocuments.length > 1 ? 'Certificate information and copy count are specific to this document. Requirements below are listed once for the selection.' : 'Certificate information, copy count, and requirements are specific to this document.'}</small></div>
                  <label className="request-copy-count-field">
                    <span>Number of copies</span>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      required
                      aria-label={`Number of ${currentRequestDocument} copies`}
                      value={documentCopyCounts[currentRequestDocument] ?? 1}
                      onChange={(event) => updateDocumentCopyCount(currentRequestDocument, event.target.value)}
                    />
                    <small>{getDocumentFeeSubtotal(currentRequestDocument) === null
                      ? 'Enter a whole number of copies'
                      : `₱${Number(documentFees[currentRequestDocument] || 0).toFixed(2)} per copy · Subtotal ₱${getDocumentFeeSubtotal(currentRequestDocument).toFixed(2)}`}</small>
                  </label>
                </div>
                <div className="request-personal-column">
                <div className="request-personal-fields">
                  <div className="request-form-section-heading"><span className="request-form-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" /><path d="M4 21c.7-4.1 3.3-6.2 8-6.2s7.3 2.1 8 6.2" /></svg></span><div><p className="document-label">Personal details</p><span>Fill in each field requested by this document.</span></div></div>
                  <div className="certificate-request-fields">
                    {uniqueRequestCertificateFields.map((field) => {
                      const fieldId = `certificate-field-${field.key}`
                      const value = requestCertificateValues[field.key] ?? ''
                      if (field.isCheckbox && field.options?.length) {
                        return <fieldset className="certificate-field-options" key={field.key} aria-describedby={requestDetailError ? 'certificate-field-error' : undefined}>
                          <legend>{field.label}<span>{field.multiple ? 'Select all that apply' : 'Choose one'}</span></legend>
                          <div>{field.options.map((option) => {
                            const selected = field.multiple
                              ? Array.isArray(value) && value.includes(option)
                              : value === option
                            return <label className={selected ? 'checked' : ''} key={option}>
                            <input type="checkbox" checked={selected} onChange={() => {
                              if (field.multiple) {
                                const selections = Array.isArray(value) ? value : []
                                updatePersonalDetail(field.key, selected
                                  ? selections.filter((selection) => selection !== option)
                                  : [...selections, option])
                              } else {
                                updatePersonalDetail(field.key, selected ? '' : option)
                              }
                            }} />
                            <span className="certificate-checkbox-mark" aria-hidden="true">{selected ? '✓' : ''}</span>
                            <span>{option}</span>
                          </label>
                          })}</div>
                        </fieldset>
                      }
                      return <div className={`certificate-request-field${field.type === 'textarea' ? ' is-wide' : ''}`} key={field.key}>
                        <label htmlFor={fieldId}>
                          {field.label}
                          {field.key === 'fullName' && <small>Prefilled from your resident account; you can edit it.</small>}
                          {(field.key === 'appearanceAddress' || (field.key === 'address' && currentRequestDocument === 'Barangay Clearance')) && <small>Select only Zone 1–Zone 7. The barangay and municipality are added automatically.</small>}
                          {field.key === 'issuePurpose' && <small>Enter why you appeared at the barangay office. Required for printing.</small>}
                          {field.key === 'appearanceDate' && <small>Enter the date you appeared. This is different from the issue date.</small>}
                        </label>
                        {field.type === 'textarea'
                          ? <textarea id={fieldId} value={value} onChange={(event) => updatePersonalDetail(field.key, event.target.value)} placeholder={field.key === 'issuePurpose' ? 'For example: school enrollment, employment, or appointment' : undefined} required />
                          : field.options?.length
                            ? <select id={fieldId} value={value} onChange={(event) => updatePersonalDetail(field.key, event.target.value)} required>
                              <option value="" disabled>Select {field.label.toLowerCase()}</option>
                              {field.options.map((option) => <option value={option} key={option}>{option}</option>)}
                            </select>
                            : <input
                              id={fieldId}
                              type={field.type || 'text'}
                              value={value}
                              onChange={(event) => updatePersonalDetail(field.key, event.target.value)}
                              required
                              min={field.type === 'number' ? '0' : undefined}
                              step={field.type === 'number' ? '1' : undefined}
                            />}
                      </div>
                    })}
                    {!hasRequestPurposeField && <div className="certificate-request-field is-wide">
                      <label htmlFor="certificate-field-purpose">Purpose of request</label>
                      <textarea
                        id="certificate-field-purpose"
                        value={requestCertificateValues.purpose || ''}
                        onChange={(event) => updatePersonalDetail('purpose', event.target.value)}
                        required
                      />
                    </div>}
                  </div>
                  {requestDetailError && <p className="certificate-request-error" id="certificate-field-error" role="alert">{requestDetailError}</p>}
                </div>
                {selectedRequestRequirements.some((requirement) => requirement !== 'Valid government ID') && <section className="additional-requirement-uploads">
                  <div className="request-form-section-heading"><span className="request-form-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 7h4l2-2h4l2 2h4v12H4z" /><circle cx="12" cy="13" r="3.5" /></svg></span><div><p className="document-label">Other required photos</p><span>Upload the remaining document requirements below.</span></div></div>
                  <div className="photo-upload-list">
                    {selectedRequestRequirements.filter((requirement) => requirement !== 'Valid government ID').map((requirement) => (
                      <RequirementPhotoUpload
                        key={requirement}
                        requirement={requirement}
                        selectedDocuments={selectedDocuments}
                        currentRequestDocument={currentRequestDocument}
                        requirementPhotos={requirementPhotos}
                        requirementPhotoLoading={requirementPhotoLoading}
                        updateRequirementPhoto={updateRequirementPhoto}
                        customTemplates={customCertificateTemplates}
                      />
                    ))}
                  </div>
                </section>}
                </div>
                <div className="requirements-box">
                  <div className="request-form-section-heading"><span className="request-form-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M7 3h10l4 4v14H7zM17 3v5h4M10 13h8M10 17h8" /><path d="m3 13 2 2 3-4" /></svg></span><div><p className="document-label">Prepare your requirements</p><span>Each unique requirement appears once. Upload clear photos below.</span></div></div>
                  <div className="requirement-group">
                    <strong><ResidentDocumentIcon document={currentRequestDocument} />{selectedDocuments.length > 1 ? 'All selected documents' : currentRequestDocument}</strong>
                    {selectedDocuments.length > 1 && <small className="shared-requirement-note">Shared uploads are automatically attached to every separate request that needs them.</small>}
                    <ul>{selectedRequestRequirements.map((requirement) => {
                      const requiredByDocuments = selectedDocuments.filter((document) => (
                        getDocumentRequirements(document, customCertificateTemplates).includes(requirement)
                      ))
                      return <li key={requirement}>
                        {requirement}
                        {selectedDocuments.length > 1 && <small className="requirement-document-scope">
                          {requiredByDocuments.length > 1
                            ? `Shared by ${requiredByDocuments.length} documents`
                            : `For ${requiredByDocuments[0] || currentRequestDocument}`}
                        </small>}
                      </li>
                    })}</ul>
                  </div>
                  <div className="photo-upload-list id-verification-upload-list">
                    {selectedRequestRequirements.filter((requirement) => requirement === 'Valid government ID').map((requirement) => (
                      <Fragment key={requirement}>
                        <RequirementPhotoUpload
                          requirement={requirement}
                          selectedDocuments={selectedDocuments}
                          currentRequestDocument={currentRequestDocument}
                          requirementPhotos={requirementPhotos}
                          requirementPhotoLoading={requirementPhotoLoading}
                          updateRequirementPhoto={updateRequirementPhoto}
                          customTemplates={customCertificateTemplates}
                        />
                        <section className="philsys-verification-card" aria-labelledby="philsys-verification-title">
                          <div className="philsys-verification-copy">
                            <span className="philsys-verification-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.5-7 9-4.2-1.5-7-4.8-7-9V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg></span>
                            <div><strong id="philsys-verification-title">PhilSys verification</strong><p>Open the official PhilSys Check site, complete the check there, then upload a screenshot or photo showing the successful result.</p></div>
                          </div>
                          <a className="philsys-verification-link" href="https://verify.philsys.gov.ph/" target="_blank" rel="noopener noreferrer">Open PhilSys Check <span aria-hidden="true">↗</span></a>
                          <label className="philsys-evidence-upload">
                            <span>Upload successful verification result <small>Image only · visible to barangay staff for review</small></span>
                            <input type="file" accept="image/*" onChange={(event) => updatePhilSysVerificationEvidence(event.target.files[0])} required={!requirementPhotos[philsysEvidencePhotoKey]} />
                            {requirementPhotoLoading[philsysEvidencePhotoKey] ? <small>Preparing image…</small> : requirementPhotos[philsysEvidencePhotoKey] && <small>{requirementPhotos[philsysEvidencePhotoKey].fileName}</small>}
                          </label>
                        </section>
                      </Fragment>
                    ))}
                  </div>
                </div>
                </section>
                {requirementPhotoError && <p className="photo-upload-error" role="alert">{requirementPhotoError}</p>}
                <div className="request-form-actions">
                  <p className="request-form-fee-total">Total document fee <strong>{getSelectedRequestFeeTotal() === null ? 'Check copy counts' : `₱${getSelectedRequestFeeTotal().toFixed(2)}`}</strong></p>
                  <button type="submit" className="check-button" disabled={Boolean(requirementPhotoError) || Object.values(requirementPhotoLoading).some(Boolean)}>Continue to review <span aria-hidden="true">→</span></button>
                  {!returnToResidentDashboardAfterRequest && <button type="button" className="back-button" onClick={() => setShowRequestForm(false)}>Back to documents</button>}
                </div>
              </form>
          ) : showDocumentOptions ? (
            <>
              <div className="resident-heading">
                <p className="section-number">STEP 2 · DOCUMENT SERVICES</p>
                <h1>Choose your<br /><em>documents.</em></h1>
                <p className="intro-copy">Select the barangay documents you need. Set the number of copies for each document during the details step.</p>
              </div>
              <div className="resident-form document-form">
                <header className="resident-document-choice-heading">
                  <span className="request-form-section-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M6 3.5h8l4 4V21H6zM14 3.5v4h4M9 12h6M9 16h6" /></svg></span>
                  <span><strong>Choose your documents</strong><small>Select the services you need. Fees are shown for each document.</small></span>
                </header>
                <div className="document-options">
                  {allCertificateDocuments.filter((document) => enabledCertificateTypes.includes(document)).map((document, index) => {
                    const isSelected = selectedDocuments.includes(document)
                    const requirementCount = getDocumentRequirements(document, customCertificateTemplates).length
                    return <label className={`document-option${isSelected ? ' selected' : ''}`} key={document}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleDocument(document)} />
                      <span className="document-option-checkmark" aria-hidden="true">{isSelected ? '✓' : '+'}</span>
                      <span className="document-option-icon"><ResidentDocumentIcon document={document} /></span>
                      <span className="document-option-copy">
                        <small>DOCUMENT {String(index + 1).padStart(2, '0')}</small>
                        <strong>{document}</strong>
                        <span>{requirementCount} requirement{requirementCount === 1 ? '' : 's'} to prepare</span>
                      </span>
                      <span className="resident-document-fee">₱{Number(documentFees[document] || 0).toFixed(2)} per copy</span>
                    </label>
                  })}
                </div>
                <footer className="resident-document-choice-footer">
                  <div className="resident-document-choice-summary" aria-live="polite">
                    <span><strong>{selectedDocuments.length ? `${selectedDocuments.length} selected` : 'No documents selected'}</strong><small>{selectedDocuments.length ? 'You can review your selection before submitting.' : 'Choose at least one document to continue.'}</small></span>
                    <span className="resident-document-choice-total"><small>Estimated total</small><strong>{getSelectedRequestFeeTotal() === null ? 'Check copy counts' : `₱${getSelectedRequestFeeTotal().toFixed(2)}`}</strong></span>
                  </div>
                  <div className="resident-document-choice-actions">
                    <button type="button" className="check-button" disabled={!selectedDocuments.length} onClick={() => setShowRequestForm(true)}>Continue request <span aria-hidden="true">→</span></button>
                    <button type="button" className="back-button" onClick={() => {
                      if (returnToResidentDashboardAfterRequest) {
                        if (selectedDocuments.length) {
                          leaveRequestAsDraft()
                          return
                        }
                        setShowDocumentOptions(false)
                        setShowResidentCheck(false)
                        setShowResidentInboxPage(true)
                        setResidentDashboardSection('community')
                        setReturnToResidentDashboardAfterRequest(false)
                        return
                      }
                      setShowDocumentOptions(false)
                      setSelectedDocuments([])
                    }}>{returnToResidentDashboardAfterRequest ? 'Back to my dashboard' : 'Back to verification'}</button>
                  </div>
                </footer>
              </div>
            </>
          ) : (
            <>
              <div className="resident-heading">
                <p className="section-number">{inboxAccessMode ? 'RESIDENT DASHBOARD ACCESS' : 'STEP 1 · RESIDENT VERIFICATION'}</p>
                <h1>{inboxAccessMode ? <>Open your<br /><em>dashboard.</em></> : <>Start your<br /><em>request.</em></>}</h1>
                <p className="intro-copy">{inboxAccessMode ? 'Enter the name used on your registration and your resident code to access your dashboard. Middle name and suffix are optional.' : 'Confirm your registered details, then choose the documents and information for your request.'}</p>
              </div>
              <form className={`resident-form${!inboxAccessMode ? ' official-login-card official-login-form resident-request-login-card' : ''}`} onSubmit={checkResident}>
                {!inboxAccessMode ? <>
                  <button type="button" className="official-login-back" onClick={() => {
                    if (returnToRegistrationCommunity) {
                      returnToMyRegistrationSource()
                      return
                    }
                    if (registrationSubmitted && submittedRegistrationId) {
                      setShowResidentCheck(false)
                      setShowRegistrationForm(true)
                      setRegistrationReferenceDialogOpen(true)
                      setInboxAccessMode(false)
                      setShowResidentInboxPage(false)
                      setResidentStatus('')
                      setResidentLoginError('')
                      setRegistrationReferenceNotice(null)
                      return
                    }
                    returnHome()
                  }} aria-label={returnToRegistrationCommunity ? 'Back to Community' : registrationSubmitted && submittedRegistrationId ? 'Back to registration form' : 'Back to access portal'}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M19 12H5m7 7-7-7 7-7" /></svg></button>
                  <div className="official-login-seal"><img src={barangaySeal} alt="" /></div>
                  <h1 className="official-login-title">Resident Login</h1>
                </> : <header className="resident-verification-section-heading">
                  <span className="resident-verification-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.5-7 9-4.2-1.5-7-4.8-7-9V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg></span>
                  <span><small>RESIDENT DETAILS</small><strong>Confirm your resident details</strong><em>This connects your request to your registered resident record.</em></span>
                </header>}
                <div className="name-fields resident-login-name-fields">
                  <div><label htmlFor="first-name">First name</label><input id="first-name" type="text" value={residentName.firstName} onChange={(event) => { setResidentName({ ...residentName, firstName: event.target.value }); setResidentStatus(''); setResidentLoginError(''); setRegistrationReferenceNotice(null) }} placeholder="Enter your first name" autoComplete="given-name" required /></div>
                  <div><label htmlFor="middle-name">Middle name <span>(optional)</span></label><input id="middle-name" type="text" value={residentName.middleName} onChange={(event) => { setResidentName({ ...residentName, middleName: event.target.value }); setResidentStatus(''); setResidentLoginError(''); setRegistrationReferenceNotice(null) }} placeholder="Middle name" autoComplete="additional-name" /></div>
                  <div><label htmlFor="last-name">Last name</label><input id="last-name" type="text" value={residentName.lastName} onChange={(event) => { setResidentName({ ...residentName, lastName: event.target.value }); setResidentStatus(''); setResidentLoginError(''); setRegistrationReferenceNotice(null) }} placeholder="Enter your last name" autoComplete="family-name" required /></div>
                </div>
                <div className="resident-code-field">
                  <label htmlFor="resident-code">{inboxAccessMode ? 'Resident code or application reference' : 'Resident code or application reference'}</label>
                  <input id="resident-code" type="text" value={residentName.code} onChange={(event) => { setResidentName({ ...residentName, code: event.target.value.toUpperCase() }); setResidentStatus(''); setResidentLoginError(''); setRegistrationReferenceNotice(null) }} placeholder="BB1-JG-004 or REG-2026-A1B2C3D4E5F60708" autoComplete="off" required />
                  {!inboxAccessMode && <small>Use your assigned resident code, or your application reference to check registration status.</small>}
                </div>
                <div className="resident-verification-actions">
                  <button type="submit" className="check-button">{inboxAccessMode ? 'Open Your Dashboard' : 'Log in'}</button>
                  <div className="resident-verification-feedback">
                    <p className={`resident-status ${residentStatus}`} aria-live="polite">
                      {residentStatus === 'not-found' && 'No matching resident record was found.'}
                      {residentStatus === 'registration-reference-used' && 'This application reference has already been used and can no longer be accessed.'}
                      {(residentStatus === 'service-error' || residentLoginError) && residentLoginError}
                    </p>
                    {!inboxAccessMode && <button type="button" className="resident-code-recovery-toggle" aria-haspopup="dialog" onClick={() => { setRecoveryPanelOpen(true); setRecoveryFormError('') }}>Forgot Resident Code?</button>}
                  </div>
                </div>
              </form>
              {registrationReferenceNotice?.kind === 'one-time' && <div className="registration-reference-modal-backdrop">
                <section className="registration-reference-dialog deleted" role="dialog" aria-modal="true" aria-labelledby="registration-one-time-dialog-title" aria-describedby="registration-one-time-dialog-message" tabIndex="-1" onKeyDown={(event) => {
                  if (event.key === 'Escape') acknowledgeRegistrationReferenceNotice()
                }}>
                  <p className="section-number">APPLICATION NOTICE</p>
                  <h2 id="registration-one-time-dialog-title">Application removed</h2>
                  <div className="registration-reference-dialog-note" id="registration-one-time-dialog-message">
                    <strong>Note from the barangay</strong>
                    <p>{registrationReferenceNotice.message}</p>
                  </div>
                  <button type="button" className="registration-reference-dialog-continue" onClick={acknowledgeRegistrationReferenceNotice}>Acknowledge and close</button>
                </section>
              </div>}
              {!inboxAccessMode && recoveryPanelOpen && <div className="resident-code-recovery-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setRecoveryPanelOpen(false) }}>
                <section className="resident-code-recovery-modal" role="dialog" aria-modal="true" aria-labelledby="resident-recovery-title" tabIndex="-1" onKeyDown={(event) => { if (event.key === 'Escape') setRecoveryPanelOpen(false) }}>
                  <header className="resident-code-recovery-header">
                    <div><p className="section-number">ACCOUNT ACCESS</p><h2 id="resident-recovery-title">Recover your resident code</h2></div>
                    <button type="button" className="resident-code-recovery-close" autoFocus aria-label="Close resident code recovery" onClick={() => setRecoveryPanelOpen(false)}>×</button>
                  </header>
                  <div className="resident-code-recovery-content">
                  <p className="resident-code-recovery-intro">For your protection, resident codes are not shown online. Provide the email address saved on your record so staff can review your request.</p>
                  {!recoverySubmittedId ? (
                    <form className="resident-recovery-form" onSubmit={submitRecoveryRequest}>
                      {recoveryFormEditingRequestId && <p className="recovery-form-status" role="status">Editing pending request {recoveryFormEditingRequestId}. Saving will update the same request.</p>}
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-full-name">Registered full name</label>
                        <input id="recovery-full-name" value={recoveryForm.fullName} onChange={(event) => setRecoveryForm({ ...recoveryForm, fullName: event.target.value })} autoComplete="name" required />
                      </div>
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-birth-date">Date of birth</label>
                        <input id="recovery-birth-date" type="date" value={recoveryForm.birthDate} onChange={(event) => setRecoveryForm({ ...recoveryForm, birthDate: event.target.value })} required />
                      </div>
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-contact-info">Email address</label>
                        <input id="recovery-contact-info" type="email" value={recoveryForm.contactInfo} onChange={(event) => setRecoveryForm({ ...recoveryForm, contactInfo: event.target.value })} autoComplete="email" placeholder="name@example.com" required />
                      </div>
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-address">Registered address</label>
                        <input id="recovery-address" value={recoveryForm.address} onChange={(event) => setRecoveryForm({ ...recoveryForm, address: event.target.value })} autoComplete="street-address" required />
                      </div>
                      <div className="resident-recovery-field is-full-width">
                        <label htmlFor="recovery-reason">Reason for assistance</label>
                        <textarea id="recovery-reason" value={recoveryForm.reason} onChange={(event) => setRecoveryForm({ ...recoveryForm, reason: event.target.value })} rows="3" required />
                      </div>
                      <button type="button" className="recovery-check-details" onClick={checkRecoveryDetails}>Check my details</button>
                      {recoveryFormStatus && <p className="recovery-form-status" role="status">{recoveryFormStatus}</p>}
                      {recoveryFormError && <p className="recovery-form-error" role="alert">{recoveryFormError}</p>}
                      {recoveryFormEditingRequestId && <button type="button" className="recovery-check-details" onClick={cancelRecoveryFormEdit}>Cancel editing</button>}
                      <button type="submit" className="check-button recovery-submit-button">{recoveryFormEditingRequestId ? 'Save changes' : 'Send recovery request'}</button>
                    </form>
                  ) : <div className="recovery-submission-success" role="status">
                    <strong>{recoverySubmissionMessage || 'Request submitted for staff review.'}</strong>
                    <span>Reference number</span><code>{recoverySubmittedId}</code>
                    <p>Save this reference to check your request status. Codes and account details will only be released after staff verify you in person.</p>
                    {residentCodeRecoveryRequests.some((request) => request.id === recoverySubmittedId && request.status === 'Pending') && <button type="button" className="recovery-check-details" onClick={editSubmittedRecoveryRequest}>Edit submitted details</button>}
                  </div>}
                  <button type="button" className="recovery-track-toggle" aria-expanded={recoveryTrackingOpen} onClick={() => setRecoveryTrackingOpen((open) => !open)}>Already submitted? Track your request</button>
                  {recoveryTrackingOpen && <>
                    <form className="recovery-status-lookup" onSubmit={checkRecoveryRequestStatus}>
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-reference">Request reference</label>
                        <input id="recovery-reference" value={recoveryLookup.reference} onChange={(event) => setRecoveryLookup({ ...recoveryLookup, reference: event.target.value })} required />
                      </div>
                      <div className="resident-recovery-field">
                        <label htmlFor="recovery-lookup-name">Registered full name</label>
                        <input id="recovery-lookup-name" value={recoveryLookup.fullName} onChange={(event) => setRecoveryLookup({ ...recoveryLookup, fullName: event.target.value })} required />
                      </div>
                      <button type="submit" className="recovery-check-details">Check status</button>
                    </form>
                    {recoveryLookupResult && <section className="recovery-tracking-result" aria-live="polite">
                      <p className="recovery-form-status"><strong>{recoveryLookupResult.status === 'not-found' ? 'Not found' : recoveryLookupResult.status}</strong> · {recoveryLookupResult.message}</p>
                      {recoveryLookupResult.request && <>
                        <div className="recovery-tracking-result-heading"><div><h3>Submitted recovery details</h3><span>{recoveryLookupResult.request.id}</span></div>
                          {recoveryLookupResult.request.status === 'Pending' && <button type="button" className="recovery-check-details" onClick={() => {
                            if (recoveryTrackingEditOpen) {
                              setRecoveryTrackingEditOpen(false)
                              setRecoveryTrackingEditError('')
                            } else {
                              openRecoveryTrackingEdit(recoveryLookupResult.request)
                            }
                          }}>{recoveryTrackingEditOpen ? 'Cancel editing' : 'Edit details'}</button>}
                        </div>
                        {!recoveryTrackingEditOpen ? <dl className="recovery-tracking-data">
                          <div><dt>Resident name</dt><dd>{recoveryLookupResult.request.fullName}</dd></div>
                          <div><dt>Date of birth</dt><dd>{recoveryLookupResult.request.birthDate}</dd></div>
                          <div><dt>Email address</dt><dd>{recoveryLookupResult.request.emailAddress || 'Not provided'}</dd></div>
                          <div><dt>Address</dt><dd>{recoveryLookupResult.request.address}</dd></div>
                          <div className="recovery-tracking-wide"><dt>Reason for assistance</dt><dd>{recoveryLookupResult.request.reason}</dd></div>
                          <div><dt>Submitted</dt><dd>{recoveryLookupResult.request.submittedAt ? new Date(recoveryLookupResult.request.submittedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : 'Date not recorded'}</dd></div>
                          <div className="recovery-tracking-wide"><dt>Email update</dt><dd>{recoveryLookupResult.request.codeSentAt
                            ? `Resident code sent to ${recoveryLookupResult.request.deliveryDestination || 'the saved email'} on ${new Date(recoveryLookupResult.request.codeSentAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}.`
                            : recoveryLookupResult.request.declineNoticeSentAt
                              ? `Decline notice sent to ${recoveryLookupResult.request.declineNoticeDestination || 'the submitted email'} on ${new Date(recoveryLookupResult.request.declineNoticeSentAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}. No resident code was sent.`
                              : recoveryLookupResult.request.status === 'Declined'
                                ? 'Request declined. No email notice or resident code was recorded.'
                                : 'No resident code has been emailed yet.'}</dd></div>
                          {recoveryLookupResult.request.updatedAt && <div><dt>Last updated</dt><dd>{new Date(recoveryLookupResult.request.updatedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>}
                          {recoveryLookupResult.request.reviewedAt && <div><dt>Reviewed</dt><dd>{new Date(recoveryLookupResult.request.reviewedAt).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' })}</dd></div>}
                        </dl> : <form className="recovery-tracking-edit-form" onSubmit={saveRecoveryTrackingEdit}>
                          <label>Registered full name<input value={recoveryTrackingEditForm.fullName} onChange={(event) => setRecoveryTrackingEditForm({ ...recoveryTrackingEditForm, fullName: event.target.value })} autoComplete="name" required /></label>
                          <label>Date of birth<input type="date" value={recoveryTrackingEditForm.birthDate} onChange={(event) => setRecoveryTrackingEditForm({ ...recoveryTrackingEditForm, birthDate: event.target.value })} required /></label>
                          <label>Email address<input type="email" value={recoveryTrackingEditForm.contactInfo} onChange={(event) => setRecoveryTrackingEditForm({ ...recoveryTrackingEditForm, contactInfo: event.target.value })} autoComplete="email" required /></label>
                          <label>Registered address<input value={recoveryTrackingEditForm.address} onChange={(event) => setRecoveryTrackingEditForm({ ...recoveryTrackingEditForm, address: event.target.value })} autoComplete="street-address" required /></label>
                          <label className="recovery-tracking-wide">Reason for assistance<textarea value={recoveryTrackingEditForm.reason} onChange={(event) => setRecoveryTrackingEditForm({ ...recoveryTrackingEditForm, reason: event.target.value })} rows="3" required /></label>
                          {recoveryTrackingEditError && <p className="recovery-form-error" role="alert">{recoveryTrackingEditError}</p>}
                          <div className="recovery-tracking-edit-actions"><button type="submit" className="check-button">Save changes</button><button type="button" className="recovery-check-details" onClick={() => { setRecoveryTrackingEditOpen(false); setRecoveryTrackingEditError('') }}>Cancel</button></div>
                        </form>}
                      </>}
                    </section>}
                  </>}
                  <p className="recovery-registration-link">New resident? <button type="button" onClick={() => chooseResidentPath('registration')}>Open the registration form</button></p>
                  </div>
                </section>
              </div>}
            </>
          )}
          {((showDocumentOptions && !showRequestForm && !showReview) || requestSubmitted) && (
            <>
              <button type="button" className={`resident-inbox-trigger ${showResidentInbox ? 'is-open' : ''}`} onClick={() => setShowResidentInbox((isOpen) => !isOpen)} aria-expanded={showResidentInbox} aria-controls="resident-inbox-panel" aria-label={showResidentInbox ? 'Hide document updates' : 'Show document updates'}>
                <span className="resident-inbox-trigger-label">Inbox</span>
                <span className="resident-inbox-count">{residentUpdateCount}</span>
              </button>
              {showResidentInbox && <aside id="resident-inbox-panel" className="resident-inbox" aria-label="My document updates">
              <div className="resident-inbox-heading">
                <div>
                  <p className="section-number">MY INBOX</p>
                  <h2>Document updates</h2>
                </div>
                <span className="resident-inbox-count">{residentUpdateCount} update{residentUpdateCount === 1 ? '' : 's'}</span>
              </div>
              {residentInboxRequests.length ? (
                <div className="resident-inbox-list">
                  {residentInboxRequests.map((request) => {
                    const latestUpdate = (request.activity || []).slice(-1)[0]
                    const statusLabel = residentStatusLabels[request.status] || request.status
                    const statusClass = request.status.toLowerCase().replace(/[^a-z]+/g, '-')

                    return (
                      <article className="resident-inbox-item" key={request.id}>
                        <div className="resident-inbox-item-heading">
                          <div>
                            <p className="resident-inbox-request-id">{request.id}</p>
                            <strong>{request.documents.join(' · ')}</strong>
                          </div>
                          <span className={`resident-status-badge ${statusClass}`}>{statusLabel}</span>
                        </div>
                        <RequestTrackingTimeline request={request} />
                        {request.pickupDate && <p className="resident-pickup-notice">Pickup schedule: <strong>{formatPickupSchedule(request.pickupDate, request.pickupTime)}</strong>{request.pickupInstructions && <span>{request.pickupInstructions}</span>}</p>}
                        {request.status === 'Ready for release' && !request.pickupNotificationSentAt && <p className="resident-pickup-notice">Your documents are ready for release. Pickup date, time, and instructions will be shared soon.</p>}
                        {request.status === 'Returned for edits' && request.editRequestNote && <div className="resident-decline-notice"><p><strong>Edits requested:</strong> {request.editRequestNote}</p></div>}
                        {latestUpdate && <p className="resident-latest-update"><strong>Latest update:</strong> {latestUpdate.action}<span>{latestUpdate.by} · {latestUpdate.time}</span></p>}
                        {request.declineReason && <div className="resident-decline-notice"><p><strong>Reason for decline:</strong> {request.declineReason}</p><span>Requirements to correct: {request.invalidRequirements.join(' · ')}</span></div>}
                        <details className="resident-update-history">
                          <summary>All document updates</summary>
                          <ol>{(request.activity || []).slice().reverse().map((entry, index) => <li key={`${entry.time}-${index}`}><strong>{entry.action}</strong><span>{entry.by} · {entry.time}</span></li>)}</ol>
                        </details>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <p className="resident-inbox-empty">Your document updates will appear here after you submit a request.</p>
              )}
              </aside>}
            </>
          )}
        </section>
      ) : !hasStarted ? (
        <section className="startup-screen" aria-labelledby="startup-heading">
          <div className="startup-brand">
            <img src={barangaySeal} alt="Barangay Bagong Bayan 1 seal" />
            <div><strong>BARANGAY BAGONG BAYAN 1</strong><span>COMMUNITY SERVICE PORTAL</span></div>
          </div>
          <div className="startup-copy">
            <p className="startup-kicker"><span aria-hidden="true" /> YOUR COMMUNITY, CONNECTED</p>
            <h1 id="startup-heading">Welcome to<br /><em>your barangay.</em></h1>
            <p className="startup-description">Local services, official records, and community updates — all in one place.</p>
            <button type="button" className="startup-start-button" onClick={startSystem}>
              Start system <span aria-hidden="true">→</span>
            </button>
            <p className="startup-start-hint">Start here to continue to the portal</p>
          </div>
          <div className="startup-visual" aria-hidden="true">
            <div className="startup-orbit startup-orbit-outer" />
            <div className="startup-orbit startup-orbit-inner" />
            <div className="startup-seal-stage">
              <img src={barangaySeal} alt="" />
              <span>BB1</span>
            </div>
            <div className="startup-visual-caption"><span>BARANGAY BAGONG BAYAN 1</span><strong>Local service. Stronger community.</strong></div>
          </div>
          <div className="startup-bottom-line">
            <span>DOCUMENT REQUESTS</span><i aria-hidden="true" />
            <span>OFFICIAL RECORDS</span><i aria-hidden="true" />
            <span>COMMUNITY UPDATES</span>
          </div>
        </section>
      ) : (
        <section className="welcome-content">
          <div className="intro-block">
            <p className="welcome-eyebrow"><span aria-hidden="true" /> BARANGAY BAGONG BAYAN 1 · ACCESS PORTAL</p>
            <h1>Your barangay,<br /><em>within reach.</em></h1>
            <p className="intro-copy">A convenient place to request local services, follow your applications, and stay connected with community updates.</p>
            <div className="welcome-service-highlights" aria-label="Portal features">
              <div>
                <span className="welcome-service-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7zM14 3v6h5M10 13h6M10 17h5" /></svg></span>
                <span><strong>Document services</strong><small>Request online</small></span>
              </div>
              <div>
                <span className="welcome-service-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg></span>
                <span><strong>Track requests</strong><small>Follow each update</small></span>
              </div>
              <div>
                <span className="welcome-service-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 5h16v12H9l-5 4z" /><path d="M8 9h8M8 13h5" /></svg></span>
                <span><strong>Community news</strong><small>Events and notices</small></span>
              </div>
            </div>
          </div>

          <div className="role-panel">
            <div className="role-panel-heading">
              <div><p className="panel-label">GET STARTED</p><h2>Choose your access</h2></div>
              <span className="role-panel-step"><strong>03</strong><i>OPTIONS</i></span>
            </div>
            <div className="role-options">
              <button type="button" className={`role-button ${selectedRole === 'resident' ? 'is-selected' : ''}`} onClick={() => chooseRole('resident')}>
                <span className="role-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m3 10 9-7 9 7M5 9v11h14V9M9 20v-6h6v6" /></svg></span>
                <span className="role-text"><strong>Resident</strong><small>Access your community services</small></span>
                <span className="arrow" aria-hidden="true">↗</span>
              </button>
              <button type="button" className={`role-button ${selectedRole === 'official' ? 'is-selected' : ''}`} onClick={() => chooseRole('official')}>
                <span className="role-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M3 21h18M5 21V8l7-4 7 4v13M9 10h.01M15 10h.01M9 14h.01M15 14h.01M10 21v-4h4v4" /></svg></span>
                <span className="role-text"><strong>Official</strong><small>Manage barangay records</small></span>
                <span className="arrow" aria-hidden="true">↗</span>
              </button>
              <button type="button" className={`role-button ${showPublicSidebar ? 'is-selected' : ''}`} onClick={() => setShowPublicSidebar((isOpen) => !isOpen)} aria-expanded={showPublicSidebar} aria-controls="community-sidebar">
                <span className="role-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 7.5h.01" /></svg></span>
                <span className="role-text"><strong>Community updates</strong><small>Meet officials and view schedules</small></span>
                <span className="arrow" aria-hidden="true">{'\u2197'}</span>
              </button>
            </div>
            <p className="selection-message" aria-live="polite">
              {selectedRole ? `${selectedRole[0].toUpperCase()}${selectedRole.slice(1)} access selected.` : 'Select a role to continue.'}
            </p>
          </div>
          <button type="button" className={`community-tab ${showPublicSidebar ? 'is-open' : ''}`} onClick={() => setShowPublicSidebar((isOpen) => !isOpen)} aria-expanded={showPublicSidebar} aria-controls="community-sidebar">{showPublicSidebar ? 'Close updates' : 'Community updates'} <span aria-hidden="true">{showPublicSidebar ? '→' : '←'}</span></button>
          <aside id="community-sidebar" className={`public-sidebar ${showPublicSidebar ? 'is-open' : ''}`} aria-label="Community updates">
            <div className="sidebar-heading">
              <div className="community-updates-heading">
                <span className="community-updates-mark" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none"><path d="M3 10.5 12 3l9 7.5M5.5 9v11h13V9M9 20v-6h6v6" /></svg>
                </span>
                <span className="community-updates-heading-copy"><span className="section-number">BARANGAY BAGONG BAYAN 1</span><strong>Community updates</strong><small>Officials, schedules &amp; community news</small></span>
              </div>
              <button type="button" className="community-sidebar-close" aria-label="Close Community Updates" onClick={() => setShowPublicSidebar(false)}>×</button>
            </div>
            <details className="public-official-directory">
              <summary className="public-official-directory-heading">
                <div><span className="section-number">MEET YOUR OFFICIALS</span><h2>Barangay officials</h2></div>
                <span className="public-official-count">{officialProfiles.length} officials</span>
              </summary>
              <div className="public-official-directory-grid">
                {officialProfiles.map((official, index) => {
                  const { days, hours } = getOfficialScheduleDetails(index)
                  const availability = getOfficialAvailabilityStatus(index)
                  const name = official.name?.trim() || 'Official name not set'
                  const initials = name.split(/\s+/).filter(Boolean).map((part) => part[0]).join('').slice(0, 2).toUpperCase()
                  return <article className="public-official-card" key={`${official.role}-${index}`}>
                    <div className="public-official-card-header">
                      <span className="public-official-avatar">{officialPhotos[index] ? <img src={officialPhotos[index]} alt="" /> : initials || 'BB'}</span>
                      <span className="public-official-copy">
                        <small className="public-official-role">{official.role || 'Barangay official'}</small>
                        <strong>{name}</strong>
                      </span>
                      <span className={`official-availability-status${availability.isAvailable === true ? ' is-available' : availability.isAvailable === false ? ' is-unavailable' : ' is-not-set'}`} aria-label={`Availability: ${availability.label}`}>{availability.label}</span>
                    </div>
                    <div className="public-official-schedule-lines" aria-label={`Schedule for ${official.role || 'barangay official'}`}>
                      <span className="public-official-schedule-label">OFFICE SCHEDULE</span>
                      <div>
                        <small><b>Days</b> {days || 'Not set'}</small>
                        <small><b>Hours</b> {hours || 'Not set'}</small>
                      </div>
                    </div>
                  </article>
                })}
                {!officialProfiles.length && <p className="public-official-directory-empty">Official profiles have not been added yet.</p>}
              </div>
            </details>
            <ResidentLiveOfficeSchedule schedule={officialAvailability.find((official) => official.id === 'secretary')} todayDateKey={todayDateInput} />
            <CommunityUpdatesCalendar updates={communityUpdates} />
          </aside>
        </section>
      )}

      {isHomePage && !hasStarted && (
        <section className="startup-about" aria-labelledby="startup-about-heading">
          <div className="startup-about-inner">
            <header className="startup-about-copy">
              <p className="startup-about-kicker"><span aria-hidden="true" /> OUR STORY · OUR NEIGHBORHOOD</p>
              <h2 id="startup-about-heading">Seven zones.<br /><em>One community.</em></h2>
              <p>Bagong Bayan-I became a separate barangay in 1983, when the former Poblacion was divided into five barangays. Located in Bongabong, Oriental Mindoro, it is organized into seven community zones.</p>
              <div className="startup-about-facts" aria-label="Barangay facts">
                <article><strong>68.0140</strong><span>hectares in area</span></article>
                <article><strong>7</strong><span>community zones</span></article>
                <article><strong>21 · 22</strong><span>blocks · streets</span></article>
              </div>
            </header>
            <CommunityMapGuide />
          </div>
        </section>
      )}

      <footer className="page-footer">
        <span className="page-footer-community">BARANGAY BAGONG BAYAN 1 <i aria-hidden="true" /> ONLINE SERVICES</span>
        <span>Designed for your community <span className="footer-line" /></span>
      </footer>
      {requestSubmitted && (
        <div className="request-success-backdrop">
          <section className="request-success" role="dialog" aria-modal="true" aria-labelledby="request-success-title" aria-describedby="request-success-note">
            <span className="request-success-icon" aria-hidden="true">
              <svg viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="20" />
                <path d="m15 24 6 6 12-13" />
              </svg>
            </span>
            <p className="section-number">{requestSubmittedHasPayment ? 'PAYMENT REQUIRED' : 'REQUEST RECEIVED'}</p>
            <h1 id="request-success-title">{requestSubmittedHasPayment ? <>Payment <em>required.</em></> : <>Request <em>submitted.</em></>}</h1>
            <p className="request-success-note" id="request-success-note">{requestSubmittedHasPayment
              ? 'Paid document requests stay in Payment Tracking until you submit payment proof. Submitting proof now sends the request and all submitted information to the barangay office automatically. The request appears in My Requests as pending verification; document processing starts after payment is verified. Unpaid requests can stay in Payment Tracking or be moved to Drafts.'
              : 'Your request is now with the barangay office for review. Track updates in My Requests.'}</p>
            <button type="button" className="check-button" onClick={() => {
              if (!returnToResidentDashboardAfterRequest) {
                setRequestSubmitted(false)
                setRequestSubmittedHasPayment(false)
                returnHome()
                return
              }
              setRequestSubmitted(false)
              const nextSection = requestSubmittedHasPayment ? 'payments' : 'requests'
              markResidentDashboardSectionRead(nextSection)
              setResidentDashboardSection(nextSection)
              setRequestSubmittedHasPayment(false)
              setShowResidentCheck(false)
              setShowResidentInboxPage(true)
              setReturnToResidentDashboardAfterRequest(false)
            }}>{returnToResidentDashboardAfterRequest
              ? requestSubmittedHasPayment ? <>Go to Payment Tracking <span aria-hidden="true">→</span></> : <>View requests <span aria-hidden="true">→</span></>
              : 'Done'}</button>
          </section>
        </div>
      )}
      {showResidentInboxPage && residentDashboardSection === 'requests' && selectedInboxRequest && (
        <ResidentRequestDetailDialog
          request={selectedInboxRequest}
          relatedRequests={[...residentAccountRequests, ...residentPendingPaymentRequests]}
          customTemplates={customCertificateTemplates}
          onClose={() => setSelectedInboxRequestId(null)}
          onSubmitCorrection={resubmitCorrectedRequest}
        />
      )}
      {selectedVerificationPhoto && (
        <div className="verification-photo-viewer" onClick={() => setSelectedVerificationPhoto(null)}>
          <section
            className="verification-photo-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={`${selectedVerificationPhoto.label} submitted by ${selectedVerificationPhoto.resident}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="verification-photo-dialog-header">
              <div><strong>{selectedVerificationPhoto.label}</strong><span>Submitted by {selectedVerificationPhoto.resident}</span></div>
              <button type="button" onClick={() => setSelectedVerificationPhoto(null)} aria-label="Close photo viewer">×</button>
            </div>
            <img className="verification-photo-full" src={selectedVerificationPhoto.dataUrl} alt={`${selectedVerificationPhoto.label} submitted by ${selectedVerificationPhoto.resident}`} />
          </section>
        </div>
      )}
    </main>
  )
}

export default App
