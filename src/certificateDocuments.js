import JSZip from 'jszip'
import barangayClearanceUrl from './certificate-templates/barangay-clearance.docx?url'
import businessClearanceUrl from './certificate-templates/business-clearance.docx?url'
import certificateOfAppearanceUrl from './certificate-templates/certificate-of-appearance.docx?url'
import certificateOfBusinessClosureUrl from './certificate-templates/certificate-of-business-closure.docx?url'
import certificateOfIndigencyUrl from './certificate-templates/certificate-of-indigency.docx?url'
import certificateOfResidencyUrl from './certificate-templates/certificate-of-residency.docx?url'
import incomeCertificationUrl from './certificate-templates/income-certification.docx?url'
import permitToConstructUrl from './certificate-templates/permit-to-construct.docx?url'
import soloParentCertificationUrl from './certificate-templates/solo-parent-certification.docx?url'

const barangayZoneOptions = ['Zone 1', 'Zone 2', 'Zone 3', 'Zone 4', 'Zone 5', 'Zone 6', 'Zone 7']

const fields = {
  fullName: { key: 'fullName', label: 'Resident full name' },
  address: { key: 'address', label: 'Purok', options: barangayZoneOptions },
  age: { key: 'age', label: 'Age', type: 'number' },
  birthPlace: { key: 'birthPlace', label: 'Place of birth' },
  birthDate: { key: 'birthDate', label: 'Birth date', type: 'date' },
  residentSince: { key: 'residentSince', label: 'Resident since', type: 'date' },
  civilStatus: { key: 'civilStatus', label: 'Civil status', options: ['Married', 'Single', 'Widowed'] },
  dateIssued: { key: 'dateIssued', label: 'Date issued', type: 'date' },
  businessName: { key: 'businessName', label: 'Business name' },
  businessAddress: { key: 'businessAddress', label: 'Business address' },
  businessType: { key: 'businessType', label: 'Application type', options: ['NEW', 'RENEWAL'] },
  closureDate: { key: 'closureDate', label: 'Business closure date', type: 'date' },
  appearanceAddress: {
    key: 'appearanceAddress',
    label: 'Purok',
    options: barangayZoneOptions,
  },
  issuePurpose: { key: 'issuePurpose', label: 'Purpose of appearance', type: 'textarea' },
  appearanceDate: { key: 'appearanceDate', label: 'Date of appearance', type: 'date' },
  fourPsStatus: { key: 'fourPsStatus', label: '4Ps status', options: ["4P's member", "Not a 4P's member"] },
  philHealthStatus: { key: 'philHealthStatus', label: 'PhilHealth status', options: ['PhilHealth member', 'Non-PhilHealth member'] },
  assistanceBeneficiary: { key: 'assistanceBeneficiary', label: 'Assistance beneficiary' },
  beneficiaryRelationship: { key: 'beneficiaryRelationship', label: 'Relationship to beneficiary' },
  assistanceType: {
    key: 'assistanceType',
    label: 'Type of assistance',
    options: ['Medical Assistance', 'Financial Assistance', 'Educational Assistance', 'Late Registered of Birth', 'Hospital Bill', 'Burial Assistance', 'Hemodialysis', 'Chemotherapy', 'Laboratory', 'Transportation (special cases)', 'Others'],
  },
  incomeSource: { key: 'incomeSource', label: 'Source of income' },
  monthlyIncome: { key: 'monthlyIncome', label: 'Monthly income' },
  requestor: { key: 'requestor', label: 'Person requesting certification' },
  constructionOwner: { key: 'constructionOwner', label: 'Property owner' },
  salutation: { key: 'salutation', label: 'Salutation', options: ['G.', 'Gng.'] },
  soloParentReason: { key: 'soloParentReason', label: 'Reason for solo parent status', type: 'textarea' },
  livelihood: { key: 'livelihood', label: 'Livelihood' },
  childrenCount: { key: 'childrenCount', label: 'Number of children', type: 'number' },
}

const barangayZoneNumbers = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7 }
export const normalizeBarangayZone = (value) => {
  const text = String(value || '').trim()
  const zoneMatch = text.match(/\b(?:zone|purok|sitio)\s*(?:no\.?\s*)?(vii|vi|iv|v|iii|ii|i|[1-7])\b/i)
  const token = (zoneMatch?.[1] || (/^[1-7]$/.test(text) ? text : '')).toUpperCase()
  const number = /^[1-7]$/.test(token) ? Number(token) : barangayZoneNumbers[token]
  return number ? `Zone ${number}` : ''
}

const formatCertificateAppearancePurok = (value) => {
  const zone = normalizeBarangayZone(value)
  return zone ? `${zone}, Barangay Bagong Bayan I` : ''
}

const getDateParts = (value) => {
  const date = new Date(`${value}T00:00:00`)
  if (Number.isNaN(date.getTime())) return { day: '', month: '', monthYear: '' }
  return {
    day: String(date.getDate()),
    month: date.toLocaleDateString('en-PH', { month: 'long' }),
    monthYear: date.toLocaleDateString('en-PH', { month: 'long', year: 'numeric' }),
  }
}

const dateYear = (value) => {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? '' : String(date.getFullYear())
}

const templates = {
  'Barangay Clearance': {
    file: barangayClearanceUrl,
    fields: [fields.fullName, fields.age, fields.civilStatus, fields.address, fields.dateIssued],
    blanks: [{
      paragraph: 5,
      values: {
        fullName: 0,
        age: 3,
        address: {
          slot: 5,
          render: (data) => {
            const zone = normalizeBarangayZone(data.address)
            return zone ? `${zone},` : ''
          },
        },
      },
    }, { paragraph: 11, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'monthYear' }] } }],
    replacements: [{ paragraph: 5, from: 'years old single/married', normalizePreviousSpace: true, value: (data) => (
      data.age || data.civilStatus
        ? `years old${data.civilStatus ? `, ${data.civilStatus}` : ''}`
        : null
    ) }],
  },
  'Business Clearance': {
    file: businessClearanceUrl,
    fields: [fields.fullName, fields.businessAddress, fields.businessName, fields.businessType, fields.dateIssued],
    blanks: [{ paragraph: 7, values: { fullName: 0, businessAddress: 1 } }, { paragraph: 8, values: { businessName: 0 } }, { paragraph: 15, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 3, part: 'month' }] } }],
    replacements: [{ paragraph: 15, from: '2026', value: () => '', allowEmpty: true, removeFollowingSpace: true }],
    checkboxes: [{ paragraph: 9, value: 'businessType', choices: ['NEW'] }, { paragraph: 10, value: 'businessType', choices: ['RENEWAL'] }],
  },
  'Certificate of Appearance': {
    file: certificateOfAppearanceUrl,
    fields: [fields.fullName, fields.appearanceAddress, fields.issuePurpose, fields.appearanceDate, fields.dateIssued],
    blanks: [{
      paragraph: 4,
      values: {
        fullName: 0,
        appearanceAddress: { slot: 1, render: (data) => formatCertificateAppearancePurok(data.appearanceAddress) },
        municipality: { slot: 2, render: () => 'Bongabong' },
        issuePurpose: 3,
        appearanceDate: 4,
      },
    }],
    replacements: [
      { paragraph: 6, from: '__________', value: (data) => formatDateWithoutYear(data.appearanceDate) },
      { paragraph: 6, from: '_________________________________________', value: (data) => data.issuePurpose },
      { paragraph: 8, from: '____ day of_____________, 2026', value: (data) => formatDate(data.dateIssued) },
    ],
  },
  'Certificate of Business Closure': {
    file: certificateOfBusinessClosureUrl,
    fields: [fields.fullName, fields.businessName, fields.closureDate, fields.dateIssued],
    blanks: [{ paragraph: 15, values: { fullName: 0, businessName: 1, closureDate: 3 } }, { paragraph: 16, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'month' }] } }],
    replacements: [{ paragraph: 16, from: '2026', value: (data) => dateYear(data.dateIssued) }],
  },
  'Certificate of Indigency': {
    file: certificateOfIndigencyUrl,
    fields: [fields.fullName, fields.civilStatus, fields.fourPsStatus, fields.philHealthStatus, fields.assistanceBeneficiary, fields.beneficiaryRelationship, fields.assistanceType, fields.dateIssued],
    blanks: [
      { paragraph: 5, values: { fullName: 0 } },
      { paragraph: 7, values: { assistanceBeneficiary: 0, beneficiaryRelationship: 1 } },
      { paragraph: 22, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 2, part: 'month' }] } },
    ],
    replacements: [
      { paragraph: 22, from: '2026', value: (data) => dateYear(data.dateIssued) },
      { paragraph: 7, from: 'Ang kanyang ', value: () => 'Ang ' },
      { paragraph: 7, from: 'kanyang ', value: () => 'na kanyang ' },
    ],
    checkboxes: [
      { paragraph: 5, value: 'civilStatus', choices: ['Married', 'Single', 'Widowed'], offset: 0 },
      { paragraph: 6, value: 'fourPsStatus', choices: ["4P's member", "Not a 4P's member"], offset: 0 },
      { paragraph: 6, value: 'philHealthStatus', choices: ['PhilHealth member', 'Non-PhilHealth member'], offset: 2 },
    ],
    checklist: { paragraphs: [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21], value: 'assistanceType' },
  },
  'Certificate of Residency': {
    file: certificateOfResidencyUrl,
    fields: [fields.fullName, fields.age, fields.birthPlace, fields.birthDate, fields.residentSince, fields.dateIssued],
    blanks: [{ paragraph: 6, values: { fullName: 0, age: 2, birthPlace: 3, birthDate: 4, residentSince: 5 } }, { paragraph: 13, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'monthYear' }] } }],
  },
  'Income Certification': {
    file: incomeCertificationUrl,
    fields: [fields.fullName, fields.age, fields.incomeSource, fields.monthlyIncome, fields.requestor, fields.dateIssued],
    blanks: [
      { paragraph: 9, values: { fullName: 0 } },
      { paragraph: 10, values: { monthlyIncome: 0 } },
      { paragraph: 11, values: { requestor: 0 } },
      { paragraph: 12, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'month' }] } },
    ],
    replacements: [
      { paragraph: 9, from: 'may sapat na taong gulang', value: (data) => (data.age ? `${data.age} taong gulang` : '') },
      { paragraph: 10, from: 'permanenting pinagkakakitaan, sa loob ng isang buwan sya ay kumikita ng ', value: (data) => (
        data.incomeSource
          ? `permanenting pinagkakakitaan bilang ${data.incomeSource}, sa loob ng isang buwan sya ay kumikita ng `
          : ''
      ) },
      { paragraph: 12, from: '2025', value: (data) => dateYear(data.dateIssued) },
    ],
  },
  'Permit to Construct': {
    file: permitToConstructUrl,
    fields: [fields.fullName, fields.constructionOwner, fields.dateIssued],
    blanks: [{ paragraph: 8, values: { fullName: 0, constructionOwner: { slot: 4 } } }, { paragraph: 9, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'month' }] } }],
    replacements: [{ paragraph: 9, from: '2026', value: (data) => dateYear(data.dateIssued) }],
  },
  'Solo Parent Certification': {
    file: soloParentCertificationUrl,
    fields: [fields.salutation, fields.fullName, fields.age, fields.soloParentReason, fields.livelihood, fields.monthlyIncome, fields.childrenCount, fields.dateIssued],
    blanks: [{ paragraph: 7, values: { fullName: 0, age: 2, soloParentReason: 3, livelihood: 4, monthlyIncome: 5, childrenCount: 6 } }, { paragraph: 9, values: { dateIssued: [{ slot: 0, part: 'day' }, { slot: 1, part: 'month' }] } }],
    replacements: [
      { paragraph: 9, from: '2026', value: (data) => dateYear(data.dateIssued) },
      { paragraph: 7, from: 'G./Gng.', value: (data) => data.salutation },
    ],
  },
}

export const shouldPreserveCertificateSourceLayout = (documentName) => (
  ['Certificate of Appearance', 'Certificate of Residency', 'Solo Parent Certification'].includes(documentName)
)

const xmlNamespace = 'http://www.w3.org/XML/1998/namespace'
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const wordCheckboxNamespace = 'http://schemas.microsoft.com/office/word/2010/wordml'
const drawingNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const drawingMainNamespace = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const relationshipsNamespace = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const packageRelationshipsNamespace = 'http://schemas.openxmlformats.org/package/2006/relationships'
const packageContentTypesNamespace = 'http://schemas.openxmlformats.org/package/2006/content-types'
const wrapTextAtWordBoundaries = (value, maxLineLength) => {
  const words = String(value ?? '').split(/\s+/).filter(Boolean)
  const lines = []
  let line = ''
  words.forEach((word) => {
    let remaining = word
    while (remaining.length > maxLineLength) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(remaining.slice(0, maxLineLength))
      remaining = remaining.slice(maxLineLength)
    }
    if (!remaining) return
    if (line && `${line} ${remaining}`.length > maxLineLength) {
      lines.push(line)
      line = remaining
    } else {
      line = line ? `${line} ${remaining}` : remaining
    }
  })
  if (line) lines.push(line)
  return lines.join('\n')
}

const getCertificateHeaderFile = async (zip, documentXml) => {
  const relationshipsFile = zip.file('word/_rels/document.xml.rels')
  if (!relationshipsFile) throw new Error('The certificate template is missing its document relationships.')

  const relationshipsXml = new DOMParser().parseFromString(await relationshipsFile.async('text'), 'application/xml')
  if (relationshipsXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template contains invalid document relationships.')
  }

  const headerReference = documentXml.getElementsByTagNameNS(wordNamespace, 'headerReference')[0]
  if (!headerReference) throw new Error('The certificate template is missing its page header.')
  const relationshipId = headerReference.getAttributeNS(relationshipsNamespace, 'id')
  const relationship = Array.from(relationshipsXml.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
    .find((entry) => entry.getAttribute('Id') === relationshipId)
  if (!relationship) throw new Error('The certificate template header relationship could not be found.')

  const headerPath = relationship.getAttribute('Target').replace(/^\/+/, '')
  const headerFile = zip.file(headerPath.startsWith('word/') ? headerPath : `word/${headerPath}`)
  if (!headerFile) throw new Error('The certificate template header file could not be found.')

  const headerXml = new DOMParser().parseFromString(await headerFile.async('text'), 'application/xml')
  if (headerXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template header contains invalid Word XML.')
  }
  return { headerFile, headerXml }
}

export const getCertificateTemplate = (document, customTemplates = []) => (
  customTemplates.find((template) => template.name === document) || templates[document] || null
)

const getCertificateFieldType = (label, type) => (
  type === 'checkbox' || type === 'number'
    ? type
    : /\bdate\b/i.test(label) ? 'date' : type || 'text'
)
const certificateBlankRunPattern = /_{2,}|\.{3,}|-{3,}|–{3,}|—{3,}/g
const isCertificateBlankPlaceholder = (value) => (
  typeof value === 'string'
  && /^[-_.–—]{2,}$/.test(value)
)

const suggestCertificateFieldCategory = (label) => {
  const normalizedLabel = String(label || '').trim().replace(/\s+/g, ' ')
  const lowerLabel = normalizedLabel.toLowerCase()
  if (!normalizedLabel || /^(?:information|other information)\s+\d+$/i.test(normalizedLabel)) return 'Please identify this field'
  if (/\bresident since\b/.test(lowerLabel)) return 'Resident since'
  if (/\breason for solo parent status\b/.test(lowerLabel)) return 'Reason for solo parent status'
  if (/\brelationship\b/.test(lowerLabel) && /\bbeneficiary\b/.test(lowerLabel)) return 'Relationship to beneficiary'

  if (/\b(date|day|month|year|petsa|araw|buwan|taon)\b/.test(lowerLabel)) {
    if (/\b(birth|born|kapanganakan|kaarawan)\b/.test(lowerLabel)) return 'Birth date'
    if (/\b(appearance|visit|pagpunta)\b/.test(lowerLabel)) return 'Date of appearance'
    if (/\b(issued|issuance|issue)\b/.test(lowerLabel)) return 'Date issued'
    if (/\b(closure|closed)\b/.test(lowerLabel)) return 'Closure date'
    return 'Date'
  }
  if (/\b(relationship|relation)\b/.test(lowerLabel)) {
    return /\bbeneficiary\b/.test(lowerLabel) ? 'Relationship to beneficiary' : 'Relationship'
  }
  if (/\b(name|pangalan|applicant|resident|requestor|requester|requesting|person|beneficiary|owner)\b/.test(lowerLabel)) {
    if (/\b(business|company|store|enterprise)\b/.test(lowerLabel)) return 'Business name'
    if (/\b(beneficiary)\b/.test(lowerLabel)) return 'Beneficiary name'
    if (/\b(property|construction)\b/.test(lowerLabel)) return 'Property owner'
    if (/\b(requestor|requester|requesting)\b/.test(lowerLabel)) return 'Person requesting certification'
    return 'Resident full name'
  }
  if (/\b(purok|sitio|zone)\b/.test(lowerLabel)) return 'Purok'
  if (/\b(place|location|address|city|municipality|barangay|town|lugar|pook|tirahan|birthplace)\b/.test(lowerLabel)) {
    if (/\b(birth|born|kapanganakan|kaarawan|birthplace)\b/.test(lowerLabel)) return 'Place of birth'
    if (/\b(business|store|office)\b/.test(lowerLabel)) return 'Business address'
    if (/\b(city|municipality|town)\b/.test(lowerLabel)) return 'City / municipality'
    if (/\b(home|residential|residence|resident|tirahan)\b/.test(lowerLabel)) return 'Home address'
    if (/\b(address|tirahan)\b/.test(lowerLabel)) return 'Address'
    return 'Place'
  }
  if (/\bage\b|\btaong\s+gulang\b/.test(lowerLabel)) return 'Age'
  if (/\bcivil\s+status\b|\b(?:may\s+asawa|walang\s+asawa|balo)\b/.test(lowerLabel)) return 'Civil status'
  if (/\b(?:type|kind|nature)\s+of\s+(?:assistance|aid|support)\b|\b(?:assistance|aid|support)\s+type\b|\b(?:uri|klase)\s+ng\s+tulong\b/.test(lowerLabel)) {
    return 'Type of assistance'
  }
  if (/\b(purpose|reason|kadahilanan|dahilan)\b/.test(lowerLabel)) return 'Purpose'
  if (/\b(phone|mobile|telephone|contact number)\b/.test(lowerLabel)) return 'Contact number'
  if (/\b(occupation|profession|job|work)\b/.test(lowerLabel)) return 'Occupation'
  if (/\b(sex|gender)\b/.test(lowerLabel)) return 'Sex'
  if (/\b(nationality|citizenship)\b/.test(lowerLabel)) return 'Nationality'
  if (/\b(religion|faith)\b/.test(lowerLabel)) return 'Religion'
  if (/\b(education|educational attainment|school|course|grade level)\b/.test(lowerLabel)) return 'Education'
  if (/\b(income|salary|earnings|kumikita|kinikita)\b/.test(lowerLabel)) return 'Monthly income'
  if (/\b(children|child count|number of children|anak)\b/.test(lowerLabel)) return 'Number of children'
  const explicitLabel = normalizedLabel
    .replace(/^(?:the\s+)?(?:name|date|address|age)\s+of\s+/i, (prefix) => prefix.toLowerCase().startsWith('the ') ? '' : prefix)
    .replace(/[.?!,:;]+$/g, '')
  if (explicitLabel && explicitLabel.split(/\s+/).length <= 6 && !/^(?:this|that|hereby|certify|certified|resident|applicant|information)$/i.test(explicitLabel)) {
    return explicitLabel.replace(/(^|[\s/(-])(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase()}`)
  }
  return 'Please identify this field'
}

export const groupCertificateTemplateFields = (fields = []) => {
  const groupedFields = new Map()
  fields.forEach((field, index) => {
    if (!field || typeof field !== 'object') return
    const rawLabel = String(field.label || '').trim().replace(/\s+/g, ' ') || `Information ${index + 1}`
    const isCheckbox = field.type === 'checkbox'
    const label = field.detectedByScanner || Array.isArray(field.targets)
      ? rawLabel
      : isCheckbox || /^(?:day|month and year)$/i.test(rawLabel)
        || /^date issued\s*[—-]\s*(?:day|month|year|month and year)$/i.test(rawLabel)
        ? rawLabel
        : suggestCertificateFieldCategory(rawLabel, index + 1)
    const normalizedLabel = label.toLocaleLowerCase()
    const groupId = field.groupId || (isCheckbox ? `checkbox-${field.paragraph}-${normalizedLabel}` : '')
    const groupKey = isCheckbox
      ? `${normalizedLabel}:${groupId}`
      : `${normalizedLabel}:${field.key || index}`
    let group = groupedFields.get(groupKey)
    if (!group) {
      group = {
        key: field.key || `customCategory${index + 1}`,
        label,
        type: isCheckbox ? 'checkbox' : getCertificateFieldType(label, field.type),
        groupId,
        targets: [],
      }
      groupedFields.set(groupKey, group)
    }

    const targets = Array.isArray(field.targets) ? field.targets : [field]
    targets.forEach((target) => {
      if (!target || typeof target !== 'object') return
      const { targets: nestedTargets, ...location } = target
      if (nestedTargets) return
      const duplicate = group.targets.some((existing) => (
        existing.key && location.key
          ? existing.key === location.key
          : existing.paragraph === location.paragraph
            && existing.textNodeIndex === location.textNodeIndex
            && existing.placeholderStart === location.placeholderStart
      ))
      if (!duplicate) group.targets.push(location)
    })
  })

  const grouped = Array.from(groupedFields.values(), (group) => {
    const options = group.type === 'checkbox'
      ? [...new Set(group.targets.map((target) => target.choiceLabel).filter(Boolean))]
      : undefined
    return {
      ...group,
      type: getCertificateFieldType(group.label, group.type),
      ...(options ? {
        options,
        multiple: group.targets.every((target) => target.multiple !== false),
      } : {}),
    }
  })
  const dateIssuedGroups = new Map()
  const result = []
  grouped.forEach((group) => {
    const datePart = group.type === 'checkbox'
      ? null
      : group.targets.find((target) => target.datePart)?.datePart
        || group.label.match(/^Date issued\s*[—-]\s*(day|month|year|month and year)$/i)?.[1]?.toLowerCase()
    if (!datePart) {
      result.push(group)
      return
    }

    const paragraph = group.targets[0]?.paragraph
    const compositeKey = Number.isInteger(paragraph) ? `date-issued-${paragraph}` : `date-issued-${group.key}`
    let composite = dateIssuedGroups.get(compositeKey)
    if (!composite) {
      const compositeLabel = group.label.replace(/\s*[—-]\s*(?:day|month|year|month and year)$/i, '')
      composite = { ...group, label: compositeLabel, type: 'date', targets: [] }
      dateIssuedGroups.set(compositeKey, composite)
    }
    composite.targets.push(...group.targets.map((target) => ({
      ...target,
      datePart: datePart === 'month and year' ? 'monthYear' : datePart,
    })))
  })

  result.push(...dateIssuedGroups.values())
  return result.sort((first, second) => {
    const firstTarget = first.targets[0] || first
    const secondTarget = second.targets[0] || second
    return (firstTarget.paragraph ?? 0) - (secondTarget.paragraph ?? 0)
      || (firstTarget.textNodeIndex ?? 0) - (secondTarget.textNodeIndex ?? 0)
      || (firstTarget.placeholderStart ?? 0) - (secondTarget.placeholderStart ?? 0)
  })
}

export const getCertificateTemplateFields = (document, customTemplates = []) => {
  const template = getCertificateTemplate(document, customTemplates)
  if (!template) return []
  if (template.custom) {
    return groupCertificateTemplateFields(template.fields).map((field) => ({
      ...field,
      ...( /\b(?:purok|sitio|zone)\b/i.test(field.label) ? { label: 'Purok', options: barangayZoneOptions } : {}),
      isCheckbox: field.type === 'checkbox',
      multiple: field.type === 'checkbox' && field.multiple !== false,
    }))
  }

  const checkboxFields = new Set([
    ...(template.checkboxes || []).map((checkbox) => checkbox.value),
    ...(template.checklist ? [template.checklist.value] : []),
  ])
  return template.fields.map((field) => ({ ...field, isCheckbox: checkboxFields.has(field.key) }))
}

export const scanCertificateTemplateFields = async (documentBlob) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('The DOCX file is missing its main Word document.')
  const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error('The DOCX file contains invalid Word XML.')
  }
  const numberingFile = zip.file('word/numbering.xml')
  const numberingXml = numberingFile
    ? new DOMParser().parseFromString(await numberingFile.async('text'), 'application/xml')
    : null
  if (numberingXml?.getElementsByTagName('parsererror').length) {
    throw new Error('The DOCX file contains invalid list numbering data.')
  }

  const detectedFields = []
  const paragraphs = getWordParagraphs(documentXml)
  const signaturePattern = /\b(signature|signatory|sign here|signed by|pirma(?:han)?|lagda(?:an)?|thumb\s*mark|thumbmark|thumbprint)\b/i
  const textboxPlaceholderPattern = /^(?:click or tap here to enter .+|enter (?:your )?.+|type (?:your )?.+|insert .+)$/i
  const detectedTextBoxes = new Set()
  const getTextBox = (paragraph) => {
    let ancestor = paragraph.parentNode
    while (ancestor && ancestor !== documentXml.documentElement) {
      if (ancestor.namespaceURI === wordNamespace && ancestor.localName === 'txbxContent') return ancestor
      ancestor = ancestor.parentNode
    }
    return null
  }
  const getTextControl = (node) => {
    let ancestor = node.parentNode
    while (ancestor && ancestor !== documentXml.documentElement) {
      if (ancestor.namespaceURI === wordNamespace && ancestor.localName === 'sdt') {
        const properties = ancestor.getElementsByTagNameNS(wordNamespace, 'sdtPr')[0]
        const propertyNames = Array.from(properties?.children || []).map((property) => property.localName)
        if (propertyNames.some((name) => ['text', 'richText'].includes(name))) {
          const labelProperty = Array.from(properties.children)
            .find((property) => ['alias', 'tag'].includes(property.localName))
          return {
            control: ancestor,
            hasPlaceholder: propertyNames.includes('showingPlcHdr'),
            label: labelProperty?.getAttributeNS(wordNamespace, 'val') || '',
          }
        }
      }
      ancestor = ancestor.parentNode
    }
    return null
  }
  const getTextBoxLabel = (textBox) => {
    let ancestor = textBox
    while (ancestor && ancestor !== documentXml.documentElement) {
      const drawingShape = ancestor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]
      const shapeLabel = drawingShape?.getAttribute('title') || drawingShape?.getAttribute('descr')
      if (shapeLabel) return shapeLabel
      if (ancestor.localName === 'shape') {
        const label = ancestor.getAttribute('title') || ancestor.getAttribute('id')
        if (label) return label
      }
      ancestor = ancestor.parentNode
    }
    return ''
  }
  const isSignatureField = (paragraphIndex, label, textBoxLabel = '') => {
    if (signaturePattern.test(`${label} ${textBoxLabel}`)) return true
    const nearbyText = [
      ...paragraphs.slice(Math.max(0, paragraphIndex - 2), paragraphIndex),
      ...paragraphs.slice(paragraphIndex + 1, paragraphIndex + 3),
    ].map(getParagraphText).filter(Boolean).join(' ').trim()
    return nearbyText.length <= 200 && signaturePattern.test(nearbyText)
  }
  const isTrailingSignatureLine = (paragraphIndex, afterText) => {
    if (afterText.replace(/\s+/g, '').trim() && !/^[,.;:]+$/.test(afterText.replace(/\s+/g, ''))) return false
    const currentText = getParagraphText(paragraphs[paragraphIndex])
    if (!/\b(?:given|issued|ibinigay|ipinagkaloob)\b/i.test(currentText)) return false
    const hasBlankSpacer = paragraphs.slice(paragraphIndex + 1, paragraphIndex + 3)
      .some((paragraph) => !getParagraphText(paragraph).trim())
    if (!hasBlankSpacer) return false
    const followingText = paragraphs.slice(paragraphIndex + 1, paragraphIndex + 6)
      .map(getParagraphText)
      .join(' ')
    return signaturePattern.test(followingText)
      || /\b(?:punong barangay|barangay captain|municipal mayor|city mayor)\b/i.test(followingText)
  }
  const addField = (paragraphIndex, textNodeIndex, label, options = {}) => {
    const detectedLabel = String(label || '').trim() || 'Please identify this field'
    const datePart = detectedLabel.match(/^Date issued\s*[—-]\s*(day|month|year|month and year)$/i)?.[1]?.toLowerCase()
    const isResidentName = /^(?:resident full name|full name|name)$/i.test(detectedLabel)
      && !detectedFields.some((field) => field.key === 'fullName')
    const isNumericField = /^(?:age|number of children|date issued\s*[—-]\s*day|day)$/i.test(detectedLabel)
    const isFieldNeedsReview = detectedLabel === 'Please identify this field'
      || detectedLabel === 'Select an option'
    detectedFields.push({
      key: isResidentName && options.type !== 'checkbox' ? 'fullName' : `customField${detectedFields.length + 1}`,
      label: detectedLabel,
      ...(datePart ? { datePart } : {}),
      detectedByScanner: true,
      labelConfidence: isFieldNeedsReview ? 'low' : 'high',
      needsReview: isFieldNeedsReview,
      type: isNumericField && options.type !== 'checkbox' ? 'number' : 'text',
      paragraph: paragraphIndex,
      textNodeIndex,
      ...options,
    })
  }
  const inferFieldLabel = (context) => {
    const normalizedContext = String(context || '')
      .replace(/_{2,}/g, ' ')
      .replace(/\.{3,}|-{3,}|–{3,}|—{3,}/g, ' ')
      .replace(/[☐□▫◻▢☑☒]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    const parts = normalizedContext.split(/[\n:;,/|]/).map((part) => part.trim()).filter(Boolean)
    const label = (parts.pop() || normalizedContext)
      .replace(/\b(?:and|or|of|for|to|at|on|in|by|the|this|that|si|ng|na|ay)\s*$/i, '')
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      .trim()
    return label.split(/\s+/).slice(-6).join(' ').slice(-60)
  }
  const getContextualCategory = (label, before, after) => {
    const rawBeforeText = before.replace(/\s+/g, ' ').trim().toLowerCase()
    const rawAfterText = after.replace(/\s+/g, ' ').trim().toLowerCase()
    const beforeText = rawBeforeText.replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim()
    const afterText = rawAfterText.replace(/_{2,}/g, ' ').replace(/\s+/g, ' ').trim()
    const contextText = `${beforeText} ${afterText}`
    const isExplicitFullAddress = /\b(?:full|complete)\s+(?:(?:home|business|residential)\s+)?address\b|\b(?:business|store|company|office)\s+address\b|\b(?:house|lot|block|street)\s*(?:no\.?|number)?\b/i
      .test(`${label} ${contextText}`)
    if (!isExplicitFullAddress && /\b(?:purok|sitio|zone)\b/.test(contextText)) return 'Purok'
    if (!isExplicitFullAddress
      && /\b(?:resident of|residing at|lives?\s+(?:at|in)|residente ng|nakatira sa)\b/.test(beforeText)
      && /\bbarangay\b/.test(afterText)) return 'Purok'
    const issuanceMonthLabel = /\b(?:19|20)\d{2}\b/.test(afterText.slice(0, 32))
      ? 'Date issued — month'
      : 'Date issued — month and year'
    if (/\bname\s+of\s+business\s*:?\s*$/.test(beforeText)) return 'Business name'
    if (/\bowner\s+of\s+the\s+business\s+trade\s+name\s*$/.test(beforeText)) return 'Business name'
    if (/\bbusiness\s+address\s+at\s*$/.test(beforeText)) return 'Business address'
    if (/\b(?:hinihingian ng tulong|tinutulungan)\b/.test(beforeText) && /\bkanyang\s*$/.test(beforeText)) return 'Relationship to beneficiary'
    if (/\b(?:hinihingian ng tulong|tinutulungan)\b/.test(beforeText) && /\bsi\s*$/.test(beforeText)) return 'Beneficiary name'
    if (/\b(?:hinihiling ni|request(?:ed)? by)\s*$/.test(beforeText)) return 'Person requesting certification'
    if (/\b(?:sa kadahilanang|dahil sa|reason for)\s*$/.test(beforeText)) return 'Reason for solo parent status'
    if (/\b(?:hanapbuhay ay|livelihood is|occupation is)\s*$/.test(beforeText)) return 'Livelihood'
    if (/\b(?:kumikita ng|monthly income of|income of)\s*p?\s*$/.test(beforeText)) return 'Monthly income'
    if (/\bmay\s*$/.test(beforeText) && /\b(?:na\s+)?anak\b/.test(afterText)) return 'Number of children'
    if (/\b(?:city\/municipality|city|municipality|town)\s+of\s*$/.test(beforeText)) return 'City / municipality'
    if (/\bbusiness\b/.test(beforeText) && /\baddress\s+at\s*$/.test(beforeText)) return 'Business address'
    if (/\b(?:born\s+at|place of birth)\s*$/.test(beforeText) || /\blugar\s+ng\s+kapanganakan\b/.test(beforeText)) return 'Place of birth'
    if (/\b(?:born\s+at|kapanganakan)\b/.test(beforeText) && /\bon\s*$/.test(beforeText)) return 'Birth date'
    if (/\b(?:resident|residente)\b/.test(beforeText) && /\bsince\s*$/.test(beforeText)) return 'Resident since'
    if (/\b(?:closure|closed business operation)\b/.test(beforeText) && /\bsince\s*$/.test(beforeText)) return 'Business closure date'
    if (/\b(?:purpose of|for the purpose of|purpose|layunin(?:g)?|dahilan ay)\s*$/.test(beforeText)) return 'Purpose'
    if (/\bothers?\s*:?\s*$/.test(beforeText) && /\b(?:assistance|tulong|para sa)\b/.test(contextText)) {
      return 'Other assistance (specify)'
    }
    if (/\b(?:certify that|residente ng|resident of|residing at)\b/.test(beforeText) && /\bof\s*$/.test(beforeText)) return 'Home address'
    if (/\bbefore this office\b/.test(beforeText) && /\bon\s*$/.test(beforeText)) return 'Date of appearance'
    if (/\bbefore this office\b/.test(beforeText) && /\bto\s*$/.test(beforeText)) return 'Purpose'
    if (/\b(?:appearance|appeared before this office|pagpunta)\b/.test(contextText) && /\bon\s*$/.test(beforeText)) return 'Date of appearance'
    if (/^\s*day\s+of\b/.test(afterText)) return 'Day'
    if (/\b(?:day of)\s*$/.test(beforeText)
      || /\bng\s*$/.test(beforeText) && /\b(?:given this|issued this|ibinigay(?: ito)? ngayong|ipinagkaloob(?: ito)? ngayong)\b/.test(beforeText)) return issuanceMonthLabel
    if (/\b(?:given this|issued this)\s*$/.test(beforeText)
      || /\b(?:ibinigay(?: ito)? ngayong|ipinagkaloob(?: ito)? ngayong)\s+ika\s*[-–]?\s*$/.test(beforeText)) return 'Date issued — day'
    if (/\b(?:this is to certify that|ito(?:'|’)?y nagpapatunay na|ito ay nagpapatunay na|ito ay pagpapatunay na)\s+si\s*$/.test(beforeText)) return 'Resident full name'
    if (/\bpag-aari ni\s*$/.test(beforeText)) return 'Property owner'
    if (/\bowner of\s*$/.test(beforeText)) return 'Property owner'
    if (/\b(?:to certify that|grant(?:ed)? to|issued to)\s*$/.test(beforeText) || /\bsi\s+g\.?\/?gng\.?\s*$/.test(beforeText)) return 'Resident full name'
    if (/\bto\s*$/.test(beforeText) && /\b(?:purpose|reason|layunin|dahilan)\b/.test(contextText)) return 'Purpose'
    if (/\bto\s*$/.test(beforeText)) return 'Resident full name'
    if (/^\s*,?\s*(?:taong\s+gulang|years?\s+old)\b/.test(afterText)) return 'Age'
    if (/\bgiven\s+this\s*$/.test(beforeText) && /^\s*day\s+of\b/.test(afterText)) return 'Date issued — day'
    if (/\b(?:resident of|residing at|lives?\s+(?:at|in)|located at)\s*$/.test(beforeText)) return 'Home address'
    if (/^(?:is|was)\s+(?:a\s+)?resident\s+of\b/.test(afterText)) return 'Resident full name'
    if (/\bfor\s*$/.test(beforeText) && /\b(request|purpose|reason|issued upon)\b/.test(beforeText)) return 'Purpose'
    const category = suggestCertificateFieldCategory(label, detectedFields.length + 1)
    if (category !== 'Please identify this field') return category
    const nearbyText = `${beforeText.slice(-80)} ${afterText.slice(0, 80)}`
    if (/\b(date|day|month|year|petsa|araw|buwan|taon)\b|\bgiven this\b/.test(nearbyText)) return 'Date'
    if (/\b(age|aged)\b|\byears?\s+old\b/.test(nearbyText)) return 'Age'
    if (/\b(place\s+of\s+birth|birthplace|born\s+in)\b/.test(nearbyText)) return 'Place of birth'
    if (/\b(?:certify\s+that|above[- ]named\s+person|applicant|resident|requestor|requester|name\s+of|nagpapatunay na si|pagpapatunay na si)\b/.test(nearbyText)) return 'Resident full name'
    if (/\b(address|residence|resides?\s+at|living\s+at)\b/.test(nearbyText)) return 'Address'
    if (/\b(place|location|municipality|barangay|purok|lugar|pook)\b/.test(nearbyText)) return 'Place'
    const explicitLabel = String(label || '')
      .replace(/^(?:please\s+)?(?:select|choose|indicate|provide|enter|state|identify|specify)\s+/i, '')
      .replace(/^(?:what\s+(?:is|are)\s+)?(?:the\s+)?type\s+of\s+/i, '')
      .replace(/\s+(?:do you need|does the applicant|that apply|as applicable)\??$/i, '')
      .replace(/[?.!]+$/g, '')
      .trim()
    if (explicitLabel && explicitLabel.split(/\s+/).length <= 6
      && /\b(name|pangalan|address|tirahan|date|petsa|age|gulang|type|uri|purpose|layunin|reason|dahilan|income|kita|relationship|ugnayan|owner|may-ari|business|negosyo|children|anak|contact|phone|occupation|hanapbuhay|status|place|birth|kapanganakan|beneficiary|tinutulungan)\b/i.test(explicitLabel)
      && !/^(?:this|that|hereby|certify|certified|resident|applicant|information)$/i.test(explicitLabel)) {
      return explicitLabel.replace(/(^|[\s/(-])(\p{L})/gu, (match, prefix, letter) => `${prefix}${letter.toLocaleUpperCase()}`)
    }
    return category
  }
  const previousQuestionParagraphIndex = (paragraphIndex) => {
    for (let index = paragraphIndex - 1; index >= 0; index -= 1) {
      const paragraph = paragraphs[index]
      const text = getParagraphText(paragraph).trim()
      if (!text) continue
      if (/[☐□▫◻▢☑☒]/.test(text)
        || Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'sdt'))
          .some((control) => control.getElementsByTagNameNS(wordCheckboxNamespace, 'checkbox').length)) continue
      return index
    }
    return -1
  }
  const getListNumbering = (paragraph) => {
    if (!numberingXml) return null
    const properties = paragraph.getElementsByTagNameNS(wordNamespace, 'numPr')[0]
    const numberId = Array.from(properties?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'numId')
      ?.getAttributeNS(wordNamespace, 'val')
    if (!numberId) return null
    const levelIndex = Number(Array.from(properties.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'ilvl')
      ?.getAttributeNS(wordNamespace, 'val') || 0)
    const number = Array.from(numberingXml.getElementsByTagNameNS(wordNamespace, 'num'))
      .find((item) => item.getAttributeNS(wordNamespace, 'numId') === numberId)
    const abstractId = Array.from(number?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'abstractNumId')
      ?.getAttributeNS(wordNamespace, 'val')
    const abstractNumber = Array.from(numberingXml.getElementsByTagNameNS(wordNamespace, 'abstractNum'))
      .find((item) => item.getAttributeNS(wordNamespace, 'abstractNumId') === abstractId)
    const level = Array.from(abstractNumber?.children || [])
      .find((child) => child.namespaceURI === wordNamespace
        && child.localName === 'lvl'
        && Number(child.getAttributeNS(wordNamespace, 'ilvl') || 0) === levelIndex)
    const levelText = Array.from(level?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'lvlText')
      ?.getAttributeNS(wordNamespace, 'val') || ''
    const runProperties = Array.from(level?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    const fonts = runProperties?.getElementsByTagNameNS(wordNamespace, 'rFonts')[0]
    const font = ['ascii', 'hAnsi', 'eastAsia', 'cs']
      .map((attribute) => fonts?.getAttributeNS(wordNamespace, attribute) || '')
      .join(' ')
    const isCheckboxBullet = /^[☐□▫◻▢☑☒]$/.test(levelText)
      || ['\uf0f0', '\uf0a8', '\uf0fe', '\uf0fc'].includes(levelText)
    return { numberId, levelIndex, levelText, font, isCheckboxBullet }
  }
  const isUnderlinedBlankText = (node) => {
    const text = node.textContent || ''
    const run = node.parentNode
    const properties = Array.from(run?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    const underline = Array.from(properties?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'u')
    const whitespaceLength = text.replace(/[,.]/g, '').length
    const hasUnderlinedTab = Array.from(run?.getElementsByTagNameNS(wordNamespace, 'tab') || []).length > 0
    return Boolean(underline && underline.getAttributeNS(wordNamespace, 'val') !== 'none'
      && /^\s*[,.]?\s*$/.test(text) && (whitespaceLength >= 3 || hasUnderlinedTab))
  }
  const getCheckboxQuestionLabel = (prompt, optionLabels = []) => {
    const optionText = optionLabels.join(' ').toLowerCase()
    const promptText = String(prompt || '').toLowerCase()
    const combinedText = `${promptText} ${optionText}`
    if (/\b(?:civil status|single|married|widowed|may asawa|walang asawa|balo)\b/.test(combinedText)) return 'Civil status'
    if (/\bphilhealth\b/.test(combinedText)) return 'PhilHealth status'
    if (/\b(?:4p|pantawid)\b/.test(combinedText)) return '4Ps status'
    if (/\b(?:new|renewal)\b/.test(optionText) && /\b(?:business|permit|application|clearance)\b/.test(combinedText)) {
      return 'Application type'
    }
    if (/\b(?:medical|financial|educational|burial|hospital bill|hemodialysis|chemotherapy|laboratory|transportation)\b/.test(optionText)
      || /\b(?:type of assistance|assistance|tulong|para sa)\b/.test(promptText)) return 'Type of assistance'
    if (/\b(?:male|female|lalaki|babae)\b/.test(optionText) || /\b(?:sex|gender|kasarian)\b/.test(promptText)) return 'Sex'
    if (/\b(?:yes|no|oo|hindi)\b/.test(optionText) && /\b(?:member|kasapi|enrolled|registered)\b/.test(combinedText)) {
      return 'Membership status'
    }
    if (/\b(?:purpose|layunin|reason|dahilan)\b/.test(promptText)) return 'Purpose'
    const promptLabel = suggestCertificateFieldCategory(prompt)
    if (promptLabel !== 'Please identify this field') return promptLabel
    return 'Select an option'
  }
  const getCheckboxDetails = (paragraphIndex, paragraphText, checkboxStart, checkboxEnd) => {
    const prefix = paragraphText.slice(0, checkboxStart)
    const previousCheckboxes = Array.from(prefix.matchAll(/[☐□▫◻▢☑☒]/g))
    const promptPrefix = previousCheckboxes.length
      ? prefix.slice(0, previousCheckboxes[previousCheckboxes.length - 1].index)
      : prefix
    const inlinePrompt = promptPrefix.split(/\n/).pop().trim().replace(/[\s:;,|/-]+$/g, '')
    const previousIndex = previousQuestionParagraphIndex(paragraphIndex)
    const previousText = previousIndex >= 0 ? getParagraphText(paragraphs[previousIndex]).trim() : ''
    const prompt = inlinePrompt || previousText
    const nextCheckboxStart = paragraphText.slice(checkboxEnd).search(/[☐□▫◻▢☑☒]/)
    const optionEnd = nextCheckboxStart < 0 ? paragraphText.length : checkboxEnd + nextCheckboxStart
    const inlineOption = paragraphText.slice(checkboxEnd, optionEnd)
      .replace(/^[\s:;,|/-]+/g, '')
      .replace(/\s+[\p{L}\p{N}'’/-]+\s*:\s*_{2,}.*$/u, '')
      .replace(/_{2,}.*$/s, '')
      .replace(/[,.!?;:].*$/s, '')
      .replace(/[\s:;,|/-]+$/g, '')
      .trim()
    const nextParagraphText = paragraphs.slice(paragraphIndex + 1)
      .map(getParagraphText)
      .find((text) => text.trim() && !/[☐□▫◻▢☑☒]/.test(text))
      ?.trim() || ''
    const choiceLabel = inlineOption || nextParagraphText || `Option ${detectedFields.length + 1}`
    const questionLabel = getCheckboxQuestionLabel(prompt, [choiceLabel])
    const multiple = questionLabel === 'Type of assistance'
      || questionLabel === 'Purpose'
      || /\b(?:select all|check all|all that apply|piliin lahat)\b/i.test(prompt)
    const promptParagraphIndex = inlinePrompt ? paragraphIndex : previousIndex >= 0 ? previousIndex : paragraphIndex
    const groupId = `checkbox-${promptParagraphIndex}-${questionLabel.toLocaleLowerCase()}`
    return { questionLabel, choiceLabel, groupId, prompt, multiple }
  }

  const numberedCheckboxGroups = new Map()
  const numberedCheckboxGroupsByParagraph = new Map()
  let activeCheckboxList = null
  paragraphs.forEach((paragraph, paragraphIndex) => {
    const text = getParagraphText(paragraph).trim()
    const numbering = getListNumbering(paragraph)
    if (!text || !numbering?.isCheckboxBullet) {
      activeCheckboxList = null
      return
    }
    if (!activeCheckboxList
      || activeCheckboxList.numberId !== numbering.numberId
      || activeCheckboxList.levelIndex !== numbering.levelIndex
      || activeCheckboxList.lastParagraphIndex !== paragraphIndex - 1) {
      activeCheckboxList = {
        id: `checkbox-list-${paragraphIndex}`,
        numberId: numbering.numberId,
        levelIndex: numbering.levelIndex,
        startParagraphIndex: paragraphIndex,
        lastParagraphIndex: paragraphIndex,
        items: [],
      }
      numberedCheckboxGroups.set(activeCheckboxList.id, activeCheckboxList)
    }
    activeCheckboxList.lastParagraphIndex = paragraphIndex
    activeCheckboxList.items.push({ paragraphIndex, numbering, choiceLabel: text.replace(/^[\s•\-–—]+/, '').trim() })
  })
  numberedCheckboxGroups.forEach((group) => {
    let promptIndex = group.startParagraphIndex - 1
    while (promptIndex >= 0 && !getParagraphText(paragraphs[promptIndex]).trim()) promptIndex -= 1
    group.prompt = promptIndex >= 0 ? getParagraphText(paragraphs[promptIndex]).trim() : ''
    const options = group.items.map((item) => item.choiceLabel.replace(/:\s*$/, '').trim())
    group.questionLabel = getCheckboxQuestionLabel(group.prompt, options)
    group.multiple = group.questionLabel === 'Type of assistance'
      || group.questionLabel === 'Purpose'
      || /\b(?:select all|check all|all that apply|piliin lahat)\b/i.test(group.prompt)
    group.promptParagraphIndex = promptIndex >= 0 ? promptIndex : group.startParagraphIndex
    group.items.forEach((item) => numberedCheckboxGroupsByParagraph.set(item.paragraphIndex, group))
  })

  paragraphs.forEach((paragraph, paragraphIndex) => {
    const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
    const textNodeOffsets = []
    let paragraphText = ''
    textNodes.forEach((textNode, textNodeIndex) => {
      textNodeOffsets[textNodeIndex] = paragraphText.length
      paragraphText += textNode.textContent || ''
    })
    const textBox = getTextBox(paragraph)
    const textBoxLabel = textBox ? getTextBoxLabel(textBox) : ''
    const checkboxControls = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'sdt'))
      .filter((control) => control.getElementsByTagNameNS(wordCheckboxNamespace, 'checkbox').length)
    const checkboxMatches = Array.from(paragraphText.matchAll(/[☐□▫◻▢☑☒]/g))
    const detectedCheckboxControls = new Set()
    const underlineMatches = Array.from(paragraphText.matchAll(certificateBlankRunPattern))
    underlineMatches.forEach((match) => {
      const start = match.index
      const end = start + match[0].length
      const startNodeIndex = textNodeOffsets.findIndex((offset, index) => (
        start >= offset && start < offset + (textNodes[index].textContent || '').length
      ))
      const endNodeIndex = textNodeOffsets.findIndex((offset, index) => (
        end - 1 >= offset && end - 1 < offset + (textNodes[index].textContent || '').length
      ))
      if (startNodeIndex < 0 || endNodeIndex < 0) return
      const before = paragraphText.slice(0, start)
      const after = paragraphText.slice(end)
      const listGroup = numberedCheckboxGroupsByParagraph.get(paragraphIndex)
      const fieldContextBefore = listGroup ? `${listGroup.prompt} ${before}` : before
      const inferredLabel = inferFieldLabel(fieldContextBefore)
      const fieldLabel = getContextualCategory(inferredLabel || textBoxLabel, fieldContextBefore, after)
      if (isSignatureField(paragraphIndex, `${inferredLabel} ${before.slice(-80)} ${after.slice(0, 80)}`, textBoxLabel)) return
      const placeholderSegments = textNodeOffsets
        .map((offset, textNodeIndex) => {
          if (textNodeIndex < startNodeIndex || textNodeIndex > endNodeIndex) return null
          const textLength = (textNodes[textNodeIndex].textContent || '').length
          const segmentStart = Math.max(0, start - offset)
          const segmentEnd = Math.min(textLength, end - offset)
          return segmentEnd > segmentStart ? { textNodeIndex, start: segmentStart, end: segmentEnd } : null
        })
        .filter(Boolean)
      addField(paragraphIndex, startNodeIndex, fieldLabel, {
        placeholder: true,
        placeholderStart: placeholderSegments[0].start,
        placeholderEnd: placeholderSegments.length === 1 ? placeholderSegments[0].end : undefined,
        ...(placeholderSegments.length > 1 ? { placeholderSegments } : {}),
        context: `${before.slice(-80)} [blank] ${after.slice(0, 80)}`.replace(/\s+/g, ' ').trim(),
        ...(fieldLabel === 'Other assistance (specify)' ? {
          parentGroupId: numberedCheckboxGroupsByParagraph.get(paragraphIndex)?.id || null,
        } : {}),
      })
    })
    checkboxMatches.forEach((match) => {
      const position = match.index
      const textNodeIndex = textNodeOffsets.findIndex((offset, index) => (
        position >= offset && position < offset + (textNodes[index].textContent || '').length
      ))
      if (textNodeIndex < 0) return
      const details = getCheckboxDetails(
        paragraphIndex,
        paragraphText,
        position,
        position + match[0].length,
      )
      if (isSignatureField(paragraphIndex, `${details.prompt} ${details.choiceLabel}`, textBoxLabel)) return
      const checkboxControlIndex = checkboxControls.findIndex((control) => control.contains(textNodes[textNodeIndex]))
      if (checkboxControlIndex >= 0) detectedCheckboxControls.add(checkboxControlIndex)
      addField(paragraphIndex, textNodeIndex, details.questionLabel, {
        type: 'checkbox',
        multiple: details.multiple,
        groupId: details.groupId,
        choiceLabel: details.choiceLabel,
        checkbox: true,
        checkboxGlyph: match[0],
        ...(checkboxControlIndex >= 0 ? { checkboxControlIndex } : {}),
        placeholderStart: position - textNodeOffsets[textNodeIndex],
        placeholderEnd: position - textNodeOffsets[textNodeIndex] + match[0].length,
        context: `${details.prompt} [${details.choiceLabel}]`.replace(/\s+/g, ' ').trim(),
      })
    })
    checkboxControls.forEach((control, checkboxControlIndex) => {
      if (detectedCheckboxControls.has(checkboxControlIndex)) return
      const controlTextNode = Array.from(control.getElementsByTagNameNS(wordNamespace, 't'))
        .find((textNode) => textNodes.includes(textNode))
      const textNodeIndex = controlTextNode ? textNodes.indexOf(controlTextNode) : -1
      const position = textNodeIndex >= 0 ? textNodeOffsets[textNodeIndex] : paragraphText.length
      const details = getCheckboxDetails(paragraphIndex, paragraphText, position, position)
      if (isSignatureField(paragraphIndex, `${details.prompt} ${details.choiceLabel}`, textBoxLabel)) return
      addField(paragraphIndex, textNodeIndex, details.questionLabel, {
        type: 'checkbox',
        multiple: details.multiple,
        groupId: details.groupId,
        choiceLabel: details.choiceLabel,
        checkbox: true,
        checkboxControlIndex,
        context: `${details.prompt} [${details.choiceLabel}]`.replace(/\s+/g, ' ').trim(),
      })
    })
    const numberedCheckboxGroup = numberedCheckboxGroupsByParagraph.get(paragraphIndex)
    if (numberedCheckboxGroup && !checkboxMatches.length && !checkboxControls.length) {
      const item = numberedCheckboxGroup.items.find((candidate) => candidate.paragraphIndex === paragraphIndex)
      if (item) {
        addField(paragraphIndex, textNodes.length ? 0 : -1, numberedCheckboxGroup.questionLabel, {
          type: 'checkbox',
          multiple: numberedCheckboxGroup.multiple,
          groupId: numberedCheckboxGroup.id,
          choiceLabel: item.choiceLabel.replace(/:\s*$/, '').trim(),
          checkbox: true,
          numberedCheckbox: true,
          numberingId: item.numbering.numberId,
          numberingLevel: item.numbering.levelIndex,
          numberingGlyph: item.numbering.levelText,
          numberingFont: item.numbering.font,
          context: `${numberedCheckboxGroup.prompt} [${item.choiceLabel}]`.replace(/\s+/g, ' ').trim(),
        })
      }
    }
    textNodes.forEach((textNode, textNodeIndex) => {
      const text = textNode.textContent || ''
      const previousText = textNodes.slice(0, textNodeIndex)
        .map((node) => node.textContent || '')
        .join('')
      const isUnderlinedBlank = isUnderlinedBlankText(textNode)
      const hasPreviousBlankSegment = textNodes.slice(0, textNodeIndex).some((previousNode, previousIndex) => (
        isUnderlinedBlankText(previousNode)
        && textNodes.slice(previousIndex + 1, textNodeIndex).every((betweenNode) => (
          /^\s*$/.test(betweenNode.textContent || '')
        ))
      ))
      const isBlankText = /^\s*[,.]?\s*$/.test(text)
      const textControl = getTextControl(textNode)
      const isTextboxPlaceholder = Boolean(textBox && textboxPlaceholderPattern.test(text.trim()))
      const isControlPlaceholder = Boolean(textControl && (
        textControl.hasPlaceholder || textboxPlaceholderPattern.test(text.trim())
      ))

      const numberedCheckboxGroup = numberedCheckboxGroupsByParagraph.get(paragraphIndex)
      const fieldContextBefore = numberedCheckboxGroup
        ? `${numberedCheckboxGroup.prompt} ${previousText}`
        : previousText
      const inferredLabel = inferFieldLabel(fieldContextBefore)
      const after = textNodes.slice(textNodeIndex).map((node) => node.textContent || '').join('')
      const afterBlank = textNodes.slice(textNodeIndex + 1).map((node) => node.textContent || '').join('')
      const fieldLabel = getContextualCategory(
        inferredLabel || textControl?.label || textBoxLabel,
        fieldContextBefore,
        after,
      )
      if (isBlankText && isUnderlinedBlank && !hasPreviousBlankSegment
        && !isSignatureField(paragraphIndex, inferredLabel || textControl?.label, textBoxLabel)
        && !isTrailingSignatureLine(paragraphIndex, afterBlank)) {
        const parentGroupId = numberedCheckboxGroup?.id || null
        addField(paragraphIndex, textNodeIndex, fieldLabel, {
          context: `${fieldContextBefore.slice(-80)} [blank] ${afterBlank.slice(0, 80)}`.replace(/\s+/g, ' ').trim(),
          ...(fieldLabel === 'Other assistance (specify)' ? { parentGroupId } : {}),
        })
        if (textBox) detectedTextBoxes.add(textBox)
      } else if (textControl && (textControl.hasPlaceholder || text === '') && isBlankText
        && !isSignatureField(paragraphIndex, inferredLabel || textControl?.label, textBoxLabel)) {
        addField(paragraphIndex, textNodeIndex, fieldLabel, { emptyTextBox: true, source: 'textbox' })
        if (textBox) detectedTextBoxes.add(textBox)
      } else if (textBox && text === '' && !isUnderlinedBlank
        && !isSignatureField(paragraphIndex, inferredLabel || textControl?.label, textBoxLabel)) {
        addField(paragraphIndex, textNodeIndex, fieldLabel, { emptyTextBox: true, source: 'textbox' })
        detectedTextBoxes.add(textBox)
      } else if ((isTextboxPlaceholder || isControlPlaceholder)
        && !isSignatureField(paragraphIndex, inferredLabel || textControl?.label, textBoxLabel)) {
        addField(paragraphIndex, textNodeIndex, fieldLabel, { placeholderText: text, source: 'textbox' })
        if (textBox) detectedTextBoxes.add(textBox)
      }
    })
  })

  Array.from(documentXml.getElementsByTagNameNS(wordNamespace, 'txbxContent')).forEach((textBox) => {
    if (detectedTextBoxes.has(textBox)) return
    const textBoxLabel = getTextBoxLabel(textBox)
    const textBoxParagraphs = Array.from(textBox.getElementsByTagNameNS(wordNamespace, 'p'))
    for (const paragraph of textBoxParagraphs) {
      const paragraphIndex = paragraphs.indexOf(paragraph)
      const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
      if (textNodes.some((textNode) => (textNode.textContent || '').trim())) continue
      if (isSignatureField(paragraphIndex, '', textBoxLabel)) continue
      const blankTextNodeIndex = textNodes.findIndex((textNode) => !(textNode.textContent || '').trim())
      addField(paragraphIndex, blankTextNodeIndex, textBoxLabel, {
        emptyTextBox: blankTextNodeIndex < 0,
        source: 'textbox',
      })
      detectedTextBoxes.add(textBox)
      break
    }
  })

  if (!detectedFields.length) {
    throw new Error('No fillable blank fields, checkbox options, or text boxes were found. Add fillable items in Word, then upload the DOCX again.')
  }
  return detectedFields.sort((first, second) => first.paragraph - second.paragraph
    || first.textNodeIndex - second.textNodeIndex
    || (first.placeholderStart || 0) - (second.placeholderStart || 0))
}

export const ageFromBirthDate = (birthDate) => {
  if (!birthDate) return ''
  const birth = new Date(`${birthDate}T00:00:00`)
  if (Number.isNaN(birth.getTime())) return ''
  const today = new Date()
  let age = today.getFullYear() - birth.getFullYear()
  if (today < new Date(today.getFullYear(), birth.getMonth(), birth.getDate())) age -= 1
  return age >= 0 ? String(age) : ''
}

export const getDefaultCertificateData = (request) => {
  const birthDate = request.details?.birthDate || ''
  const today = new Date()
  const issueDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return {
    ...request.details,
    fullName: request.resident || '',
    address: request.details?.address || '',
    age: ageFromBirthDate(birthDate),
    birthDate,
    businessAddress: request.details?.address || '',
    appearanceAddress: normalizeBarangayZone(request.details?.appearanceAddress || request.details?.address),
    municipality: 'Bongabong',
    dateIssued: issueDate,
    appearanceDate: issueDate,
  }
}

export const getDefaultRequestCertificates = (request, customTemplates = []) => Object.fromEntries(
  request.documents.filter((document) => getCertificateTemplate(document, customTemplates)).map((document) => [
    document,
    getDefaultCertificateData(request),
  ]),
)

const formatDate = (value) => {
  if (!value) return ''
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-PH', { dateStyle: 'long' })
}

const formatDateWithoutYear = (value) => {
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-PH', { dateStyle: 'long' }).replace(/,?\s*\d{4}$/, '')
}

const formatCustomDatePart = (value, part) => {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return String(value ?? '').trim()
  const [, year, month, day] = match
  if (part === 'day') return String(Number(day))
  if (part === 'month') return new Date(Number(year), Number(month) - 1, 1)
    .toLocaleDateString('en-US', { month: 'long' })
  if (part === 'year') return year
  if (part === 'monthYear') return `${new Date(Number(year), Number(month) - 1, 1).toLocaleDateString('en-US', { month: 'long' })} ${year}`
  return String(value ?? '').trim()
}

const setRunText = (textNode, value) => {
  textNode.textContent = String(value ?? '')
  textNode.setAttributeNS(xmlNamespace, 'xml:space', 'preserve')
}

const getCheckboxGlyph = (glyph, checked) => {
  if (checked) return glyph === '□' ? '☑' : '☒'
  return glyph === '☑' || glyph === '☒' ? '☐' : glyph
}

const setNumberedCheckboxState = (numberingXml, paragraph, replacement, checked, documentName) => {
  const numberingNodes = Array.from(numberingXml.getElementsByTagNameNS(wordNamespace, 'num'))
  const originalNumber = numberingNodes.find((item) => (
    item.getAttributeNS(wordNamespace, 'numId') === String(replacement.numberingId)
  ))
  const abstractId = Array.from(originalNumber?.children || [])
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'abstractNumId')
    ?.getAttributeNS(wordNamespace, 'val')
  const abstractNodes = Array.from(numberingXml.getElementsByTagNameNS(wordNamespace, 'abstractNum'))
  const originalAbstract = abstractNodes.find((item) => (
    item.getAttributeNS(wordNamespace, 'abstractNumId') === abstractId
  ))
  if (!originalNumber || !originalAbstract) {
    throw new Error(`The uploaded "${documentName}" template is missing the numbering definition for ${replacement.choiceLabel}.`)
  }

  const nextAbstractId = abstractNodes.reduce((highest, item) => Math.max(
    highest,
    Number(item.getAttributeNS(wordNamespace, 'abstractNumId')) || 0,
  ), 0) + 1
  const abstractClone = originalAbstract.cloneNode(true)
  abstractClone.setAttributeNS(wordNamespace, 'w:abstractNumId', String(nextAbstractId))
  const level = Array.from(abstractClone.children)
    .find((child) => child.namespaceURI === wordNamespace
      && child.localName === 'lvl'
      && Number(child.getAttributeNS(wordNamespace, 'ilvl') || 0) === Number(replacement.numberingLevel))
  const levelText = Array.from(level?.children || [])
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'lvlText')
  if (!level || !levelText) {
    throw new Error(`The uploaded "${documentName}" template has no checkbox marker for ${replacement.choiceLabel}.`)
  }
  levelText.setAttributeNS(wordNamespace, 'w:val', checked ? '☒' : '☐')
  let runProperties = Array.from(level.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
  if (!runProperties) {
    runProperties = numberingXml.createElementNS(wordNamespace, 'w:rPr')
    level.appendChild(runProperties)
  }
  let fonts = Array.from(runProperties.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rFonts')
  if (!fonts) {
    fonts = numberingXml.createElementNS(wordNamespace, 'w:rFonts')
    runProperties.appendChild(fonts)
  }
  fonts.setAttributeNS(wordNamespace, 'w:ascii', 'Segoe UI Symbol')
  fonts.setAttributeNS(wordNamespace, 'w:hAnsi', 'Segoe UI Symbol')

  const nextNumberId = numberingNodes.reduce((highest, item) => Math.max(
    highest,
    Number(item.getAttributeNS(wordNamespace, 'numId')) || 0,
  ), 0) + 1
  const numberClone = numberingXml.createElementNS(wordNamespace, 'w:num')
  numberClone.setAttributeNS(wordNamespace, 'w:numId', String(nextNumberId))
  const abstractReference = numberingXml.createElementNS(wordNamespace, 'w:abstractNumId')
  abstractReference.setAttributeNS(wordNamespace, 'w:val', String(nextAbstractId))
  numberClone.appendChild(abstractReference)
  numberingXml.documentElement.appendChild(abstractClone)
  numberingXml.documentElement.appendChild(numberClone)

  const numberProperties = paragraph.getElementsByTagNameNS(wordNamespace, 'numPr')[0]
  const numberIdProperty = Array.from(numberProperties?.children || [])
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'numId')
  if (!numberIdProperty) {
    throw new Error(`The uploaded "${documentName}" template no longer has the checkbox list for ${replacement.choiceLabel}.`)
  }
  numberIdProperty.setAttributeNS(wordNamespace, 'w:val', String(nextNumberId))
}

const setRunPropertiesNotBold = (runProperties) => {
  for (const localName of ['b', 'bCs']) {
    let property = Array.from(runProperties.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === localName)
    if (!property) {
      property = runProperties.ownerDocument.createElementNS(wordNamespace, `w:${localName}`)
      runProperties.appendChild(property)
    }
    property.setAttributeNS(wordNamespace, 'w:val', '0')
  }
}

const replaceRunTextWithPlainText = (
  textNode,
  beforeText,
  value,
  afterText,
  preserveBold = false,
  preserveUnderline = false,
  wrapLineLength = 0,
  ensureUnderline = false,
  allowWordWrap = false,
) => {
  const run = textNode.parentNode
  const parent = run?.parentNode
  if (!run || run.namespaceURI !== wordNamespace || run.localName !== 'r' || !parent) {
    setRunText(textNode, `${beforeText}${value ?? ''}${afterText}`)
    return
  }

  const runProperties = Array.from(run.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
  const runContent = Array.from(run.childNodes).filter((child) => child !== runProperties)
  const targetIndex = runContent.indexOf(textNode)
  if (targetIndex < 0) throw new Error('A certificate text run could not be located.')

  const createRun = (children, makePlain = false) => {
    if (!children.length) return null
    const newRun = run.cloneNode(false)
    let newProperties = runProperties?.cloneNode(true)
    if (makePlain) {
      if (!newProperties) newProperties = run.ownerDocument.createElementNS(wordNamespace, 'w:rPr')
      if (!preserveBold) setRunPropertiesNotBold(newProperties)
      if (!preserveUnderline) {
        Array.from(newProperties.getElementsByTagNameNS(wordNamespace, 'u'))
          .forEach((underline) => underline.parentNode.removeChild(underline))
      }
      if (ensureUnderline && !newProperties.getElementsByTagNameNS(wordNamespace, 'u').length) {
        const underline = run.ownerDocument.createElementNS(wordNamespace, 'w:u')
        underline.setAttributeNS(wordNamespace, 'w:val', 'single')
        newProperties.appendChild(underline)
      }
      if (allowWordWrap) {
        Array.from(newProperties.getElementsByTagNameNS(wordNamespace, 'fitText'))
          .forEach((fitText) => fitText.parentNode.removeChild(fitText))
      }
    }
    if (newProperties) newRun.appendChild(newProperties)
    children.forEach((child) => newRun.appendChild(child.cloneNode(true)))
    return newRun
  }

  const prefixNode = beforeText ? textNode.cloneNode(false) : null
  if (prefixNode) setRunText(prefixNode, beforeText)
  const valueLines = wrapLineLength > 0
    ? wrapTextAtWordBoundaries(value, wrapLineLength).split('\n')
    : [String(value ?? '')]
  const valueChildren = []
  valueLines.forEach((line, index) => {
    if (index > 0) valueChildren.push(run.ownerDocument.createElementNS(wordNamespace, 'w:br'))
    if (!line) return
    const lineNode = textNode.cloneNode(false)
    setRunText(lineNode, line)
    valueChildren.push(lineNode)
  })
  const suffixNode = afterText ? textNode.cloneNode(false) : null
  if (suffixNode) setRunText(suffixNode, afterText)

  const beforeRun = createRun([
    ...runContent.slice(0, targetIndex),
    ...(prefixNode ? [prefixNode] : []),
  ])
  const valueRun = valueChildren.length ? createRun(valueChildren, true) : null
  const afterRun = createRun([
    ...(suffixNode ? [suffixNode] : []),
    ...runContent.slice(targetIndex + 1),
  ])
  ;[beforeRun, valueRun, afterRun].filter(Boolean).forEach((newRun) => parent.insertBefore(newRun, run))
  parent.removeChild(run)
}

const removeRunFitText = (textNode) => {
  const run = textNode?.parentNode
  const properties = Array.from(run?.children || [])
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
  Array.from(properties?.getElementsByTagNameNS(wordNamespace, 'fitText') || [])
    .forEach((fitText) => fitText.parentNode.removeChild(fitText))
}

const enableCertificateTemplateTextWrapping = (documentXml) => {
  Array.from(documentXml.getElementsByTagNameNS(wordNamespace, 'tcPr')).forEach((properties) => {
    Array.from(properties.children)
      .filter((child) => child.namespaceURI === wordNamespace && child.localName === 'noWrap')
      .forEach((noWrap) => properties.removeChild(noWrap))
  })
}

const getWordParagraphs = (documentXml) => Array.from(documentXml.getElementsByTagNameNS(wordNamespace, 'p'))

const setBlankRun = (paragraph, slotIndex, value, documentName, paragraphIndex, afterText = '') => {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  const blanks = textNodes
    .filter((textNode) => /^\s*[,.]?\s*$/.test(textNode.textContent || ''))
  const target = blanks[slotIndex]
  if (!target) throw new Error(`The "${documentName}" DOCX template is missing blank field ${slotIndex + 1} in paragraph ${paragraphIndex + 1}; found ${blanks.length} blank fields.`)
  const targetIndex = textNodes.indexOf(target)
  const previousText = textNodes[targetIndex - 1]?.textContent || ''
  const nextText = textNodes[targetIndex + 1]?.textContent || ''
  const punctuation = afterText ? '' : (target.textContent || '').match(/[,.]/)?.[0] || ''
  const leadingSpace = /[\p{L}\p{N}]$/u.test(previousText) ? ' ' : ''
  const trailingSpace = /^[\p{L}\p{N}]/u.test(nextText) ? ' ' : ''
  const replacementText = `${leadingSpace}${value}${punctuation}${trailingSpace}`
  replaceRunTextWithPlainText(target, '', replacementText, '', false, true)

  if (afterText) {
    const targetRun = target.parentNode
    const followingRun = targetRun.nextSibling
    const appendedRun = paragraph.ownerDocument.createElementNS(wordNamespace, 'w:r')
    let styleSource = targetRun.previousSibling
    while (styleSource && (styleSource.namespaceURI !== wordNamespace || styleSource.localName !== 'r')) {
      styleSource = styleSource.previousSibling
    }
    const style = styleSource?.getElementsByTagNameNS(wordNamespace, 'rPr')[0]
    if (style) {
      const copiedStyle = style.cloneNode(true)
      Array.from(copiedStyle.getElementsByTagNameNS(wordNamespace, 'u')).forEach((underline) => underline.parentNode.removeChild(underline))
      appendedRun.appendChild(copiedStyle)
    }
    let appendedStyle = Array.from(appendedRun.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    if (!appendedStyle) {
      appendedStyle = paragraph.ownerDocument.createElementNS(wordNamespace, 'w:rPr')
      appendedRun.insertBefore(appendedStyle, appendedRun.firstChild)
    }
    setRunPropertiesNotBold(appendedStyle)
    const appendedText = paragraph.ownerDocument.createElementNS(wordNamespace, 'w:t')
    setRunText(appendedText, afterText)
    appendedRun.appendChild(appendedText)
    paragraph.insertBefore(appendedRun, followingRun)
  }
}

const removeTrailingUnderlinedWhitespace = (paragraph) => {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  const trailingText = textNodes[textNodes.length - 1]
  if (!trailingText || !/^\s+$/.test(trailingText.textContent || '')) return

  const trailingRun = trailingText.parentNode
  const isUnderlined = Array.from(trailingRun?.getElementsByTagNameNS(wordNamespace, 'u') || []).length > 0
  if (!isUnderlined) return

  const runTextNodes = Array.from(trailingRun.getElementsByTagNameNS(wordNamespace, 't'))
  if (runTextNodes.length === 1 && trailingRun.parentNode) {
    trailingRun.parentNode.removeChild(trailingRun)
  } else {
    setRunText(trailingText, '')
  }
}

const insertLineBreakBeforeBlank = (paragraph, slotIndex, documentName, paragraphIndex) => {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  const blank = textNodes
    .filter((textNode) => /^\s*[,.]?\s*$/.test(textNode.textContent || ''))[slotIndex]
  if (!blank) {
    throw new Error(`The "${documentName}" DOCX template is missing blank field ${slotIndex + 1} in paragraph ${paragraphIndex + 1}.`)
  }
  const lineBreak = paragraph.ownerDocument.createElementNS(wordNamespace, 'w:br')
  blank.parentNode.insertBefore(lineBreak, blank)
}

const replaceParagraphText = (paragraph, from, value, documentName, normalizePreviousSpace = false, removeFollowingSpace = false) => {
  const nodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  const target = nodes.find((textNode) => (textNode.textContent || '').includes(from))
  if (!target) throw new Error(`The "${documentName}" DOCX template is missing the expected text "${from}".`)
  const targetIndex = nodes.indexOf(target)
  const previousNode = nodes[targetIndex - 1]
  const followingNode = nodes[targetIndex + 1]
  if (normalizePreviousSpace && /^\s{2,}$/.test(previousNode?.textContent || '')) setRunText(previousNode, ' ')
  if (removeFollowingSpace && !String(value ?? '').trim() && /^\s+$/.test(followingNode?.textContent || '')) {
    setRunText(followingNode, '')
  }
  const originalText = target.textContent || ''
  const replacementIndex = originalText.indexOf(from)
  replaceRunTextWithPlainText(
    target,
    originalText.slice(0, replacementIndex),
    value,
    originalText.slice(replacementIndex + from.length),
  )
}

const setParagraphCheckbox = (paragraph, selectedIndex, offset, choiceCount) => {
  const boxes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
    .filter((textNode) => ['☐', '☑'].includes((textNode.textContent || '').trim()))
  boxes.slice(offset, offset + choiceCount).forEach((textNode, index) => {
    const spacing = (textNode.textContent || '').endsWith(' ') ? ' ' : ''
    setRunText(textNode, `${index === selectedIndex ? '☑' : '☐'}${spacing}`)
  })
}

const leftAlignFieldParagraphs = (documentXml, documentName) => {
  const paragraphIndexes = documentName === 'Barangay Clearance'
    ? [5, 11]
    : documentName === 'Income Certification'
      ? [9, 10, 11, 12]
      : []
  if (!paragraphIndexes.length) return

  const paragraphs = getWordParagraphs(documentXml)
  paragraphIndexes.forEach((paragraphIndex) => {
    const paragraph = paragraphs[paragraphIndex]
    if (!paragraph) throw new Error(`The "${documentName}" DOCX template is missing paragraph ${paragraphIndex + 1}.`)
    let properties = Array.from(paragraph.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
    if (!properties) {
      properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
      paragraph.insertBefore(properties, paragraph.firstChild)
    }
    let alignment = Array.from(properties.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'jc')
    if (!alignment) {
      alignment = documentXml.createElementNS(wordNamespace, 'w:jc')
      properties.appendChild(alignment)
    }
    alignment.setAttributeNS(wordNamespace, 'w:val', 'left')
  })
}

const adjustResidencyParagraphPosition = (documentXml, documentName) => {
  if (documentName !== 'Certificate of Residency') return
  const paragraph = getWordParagraphs(documentXml)[6]
  if (!paragraph) throw new Error('The Certificate of Residency template is missing its certification paragraph.')
  let properties = Array.from(paragraph.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
  if (!properties) {
    properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
    paragraph.insertBefore(properties, paragraph.firstChild)
  }
  let spacing = Array.from(properties.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'spacing')
  if (!spacing) {
    spacing = documentXml.createElementNS(wordNamespace, 'w:spacing')
    properties.appendChild(spacing)
  }
  spacing.setAttributeNS(wordNamespace, 'w:before', '80')
}

const normalizeResidencyUnderlineLengths = (paragraphs, documentName) => {
  if (documentName !== 'Certificate of Residency') return
  const underlineLengths = new Map([
    [6, [42, 7, 40, 20, 16]],
    [13, [7, 24]],
  ])
  underlineLengths.forEach((lengths, paragraphIndex) => {
    const paragraph = paragraphs[paragraphIndex]
    if (!paragraph) throw new Error('The Certificate of Residency template is missing its underlined fields.')
    const underlinedBlanks = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
      .filter((textNode) => {
        if (!/^\s*[,.]?\s*$/.test(textNode.textContent || '')) return false
        const run = textNode.parentNode
        const properties = Array.from(run?.children || [])
          .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
        return Array.from(properties?.children || [])
          .some((child) => child.namespaceURI === wordNamespace
            && child.localName === 'u'
            && child.getAttributeNS(wordNamespace, 'val') !== 'none')
      })
    if (underlinedBlanks.length < lengths.length) {
      throw new Error('The Certificate of Residency template is missing one or more underlined fields.')
    }
    lengths.forEach((length, index) => setRunText(underlinedBlanks[index], ' '.repeat(length)))
  })
}

const setCertificateAppearanceLineLayout = (documentXml, documentName) => {
  if (documentName !== 'Certificate of Appearance') return
  const paragraph = getWordParagraphs(documentXml)[4]
  if (!paragraph) throw new Error('The Certificate of Appearance template is missing its information paragraph.')
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  if (textNodes.length < 9 || !textNodes[2].textContent.includes(',')) {
    throw new Error('The Certificate of Appearance template is missing its expected line layout.')
  }

  let properties = Array.from(paragraph.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
  if (!properties) {
    properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
    paragraph.insertBefore(properties, paragraph.firstChild)
  }

  let spacing = Array.from(properties.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'spacing')
  if (!spacing) {
    spacing = documentXml.createElementNS(wordNamespace, 'w:spacing')
    const alignmentOrRunProperties = Array.from(properties.children)
      .find((child) => child.namespaceURI === wordNamespace && ['jc', 'rPr'].includes(child.localName))
    properties.insertBefore(spacing, alignmentOrRunProperties || null)
  }
  spacing.setAttributeNS(wordNamespace, 'w:before', '240')

  let alignment = Array.from(properties.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'jc')
  if (!alignment) {
    alignment = documentXml.createElementNS(wordNamespace, 'w:jc')
    const runProperties = Array.from(properties.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    properties.insertBefore(alignment, runProperties || null)
  }
  alignment.setAttributeNS(wordNamespace, 'w:val', 'center')

  Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'tab'))
    .forEach((tab) => tab.parentNode.removeChild(tab))

  const addBreakBefore = (textNode) => {
    const lineBreak = documentXml.createElementNS(wordNamespace, 'w:br')
    textNode.parentNode.insertBefore(lineBreak, textNode)
  }
  addBreakBefore(textNodes[6])
  addBreakBefore(textNodes[8])

  const separator = textNodes[2]
  const commaIndex = separator.textContent.indexOf(',')
  const continuation = separator.cloneNode(false)
  continuation.textContent = separator.textContent.slice(commaIndex + 1).trimStart()
  setRunText(separator, separator.textContent.slice(0, commaIndex + 1))
  const lineBreak = documentXml.createElementNS(wordNamespace, 'w:br')
  separator.parentNode.insertBefore(lineBreak, separator.nextSibling)
  separator.parentNode.insertBefore(continuation, lineBreak.nextSibling)
}

const suppressCertificateAutoHyphenation = (documentXml, documentName) => {
  if (documentName !== 'Business Clearance') return
  getWordParagraphs(documentXml).forEach((paragraph) => {
    let properties = Array.from(paragraph.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
    if (!properties) {
      properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
      paragraph.insertBefore(properties, paragraph.firstChild)
    }
    let suppressHyphens = Array.from(properties.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'suppressAutoHyphens')
    if (!suppressHyphens) {
      suppressHyphens = documentXml.createElementNS(wordNamespace, 'w:suppressAutoHyphens')
      properties.appendChild(suppressHyphens)
    }
    suppressHyphens.setAttributeNS(wordNamespace, 'w:val', '1')
  })
}

const splitPermitOwnerUnderline = (documentXml, documentName, certificateData) => {
  if (documentName !== 'Permit to Construct' || String(certificateData?.constructionOwner ?? '').trim()) return
  const paragraph = getWordParagraphs(documentXml)[8]
  if (!paragraph) throw new Error('The Permit to Construct template is missing its property-owner field.')
  const underlinedBlanks = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
    .filter((textNode) => {
      const text = textNode.textContent || ''
      const runProperties = Array.from(textNode.parentNode?.children || [])
        .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
      const isUnderlined = Array.from(runProperties?.children || [])
        .some((property) => property.namespaceURI === wordNamespace
          && property.localName === 'u'
          && property.getAttributeNS(wordNamespace, 'val') !== 'none')
      return isUnderlined && /^\s+$/.test(text) && text.length > 24
    })
  const ownerUnderline = underlinedBlanks[underlinedBlanks.length - 1]
  if (!ownerUnderline) throw new Error('The Permit to Construct template is missing its long property-owner underline.')

  const text = ownerUnderline.textContent || ''
  const splitAt = 12
  setRunText(ownerUnderline, text.slice(0, splitAt))
  const lineBreak = documentXml.createElementNS(wordNamespace, 'w:br')
  const remainingUnderline = documentXml.createElementNS(wordNamespace, 'w:t')
  setRunText(remainingUnderline, text.slice(splitAt))
  ownerUnderline.parentNode.insertBefore(lineBreak, ownerUnderline.nextSibling)
  ownerUnderline.parentNode.insertBefore(remainingUnderline, lineBreak.nextSibling)
}

const setAssistanceChecklist = (paragraphs, selectedValue, documentName, numberingXml) => {
  paragraphs.forEach((paragraph) => {
    const textNode = paragraph.getElementsByTagNameNS(wordNamespace, 't')[0]
    if (!textNode) throw new Error(`The "${documentName}" DOCX template has an empty assistance checklist item.`)
    const numberProperties = paragraph.getElementsByTagNameNS(wordNamespace, 'numPr')[0]
    const numberingId = Array.from(numberProperties?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'numId')
      ?.getAttributeNS(wordNamespace, 'val')
    const numberingLevel = Array.from(numberProperties?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'ilvl')
      ?.getAttributeNS(wordNamespace, 'val')
    if (!numberingId) {
      throw new Error(`The "${documentName}" template is missing a checkbox list for ${textNode.textContent.trim()}.`)
    }
    setNumberedCheckboxState(
      numberingXml,
      paragraph,
      {
        numberingId,
        numberingLevel: numberingLevel || 0,
        choiceLabel: textNode.textContent.trim(),
      },
      textNode.textContent.trim() === selectedValue,
      documentName,
    )
  })
}

const getParagraphText = (paragraph) => Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  .map((textNode) => textNode.textContent || '')
  .join('')

const getWordRunProperty = (runProperties, propertyName) => Array.from(runProperties?.children || [])
  .find((property) => property.namespaceURI === wordNamespace && property.localName === propertyName)

const getCertificateEditorParagraphStyle = (paragraph) => {
  const paragraphProperties = Array.from(paragraph.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
  const alignment = getWordRunProperty(paragraphProperties, 'jc')?.getAttributeNS(wordNamespace, 'val') || ''
  const firstText = paragraph.getElementsByTagNameNS(wordNamespace, 't')[0]
  let firstRun = firstText?.parentNode
  while (firstRun && firstRun !== paragraph && !(firstRun.namespaceURI === wordNamespace && firstRun.localName === 'r')) {
    firstRun = firstRun.parentNode
  }
  const runProperties = Array.from(firstRun?.children || [])
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
  const size = getWordRunProperty(runProperties, 'sz')?.getAttributeNS(wordNamespace, 'val') || ''
  const color = getWordRunProperty(runProperties, 'color')?.getAttributeNS(wordNamespace, 'val') || ''
  const bold = getWordRunProperty(runProperties, 'b')
  const italic = getWordRunProperty(runProperties, 'i')
  const underline = getWordRunProperty(runProperties, 'u')
  const fonts = getWordRunProperty(runProperties, 'rFonts')
  return {
    alignment: ['left', 'center', 'right', 'both'].includes(alignment) ? alignment : 'left',
    fontName: fonts?.getAttributeNS(wordNamespace, 'ascii') || fonts?.getAttributeNS(wordNamespace, 'hAnsi') || '',
    fontSize: /^\d+$/.test(size) ? String(Number(size) / 2) : '',
    color: /^[\da-f]{6}$/i.test(color) ? `#${color}` : '',
    bold: Boolean(bold && bold.getAttributeNS(wordNamespace, 'val') !== '0'),
    italic: Boolean(italic && italic.getAttributeNS(wordNamespace, 'val') !== '0'),
    underline: Boolean(underline && underline.getAttributeNS(wordNamespace, 'val') !== 'none'),
  }
}

const getCertificateEditorImageMimeType = (path) => ({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
}[path.split('.').pop()?.toLowerCase()] || '')
const certificateEditorPartPathPattern = /^word\/(?:document|header\d+|footer\d+|bb1-standard-header)\.xml$/

export const readCertificateTemplateForEditing = async (documentBlob) => {
  const zip = await JSZip.loadAsync(documentBlob)
  if (!zip.file('word/document.xml')) throw new Error('The DOCX file is missing its main Word document.')
  const partPaths = Object.keys(zip.files)
    .filter((path) => certificateEditorPartPathPattern.test(path))
    .sort((first, second) => {
      if (first === 'word/document.xml') return -1
      if (second === 'word/document.xml') return 1
      return first.localeCompare(second, undefined, { numeric: true })
    })
  const paragraphs = []
  for (const partPath of partPaths) {
    const xml = new DOMParser().parseFromString(await zip.file(partPath).async('text'), 'application/xml')
    if (xml.getElementsByTagName('parsererror').length) {
      throw new Error(`The DOCX part "${partPath}" contains invalid Word XML.`)
    }
    getWordParagraphs(xml).forEach((paragraph, paragraphIndex) => {
      const text = getParagraphText(paragraph)
      const style = getCertificateEditorParagraphStyle(paragraph)
      paragraphs.push({
        key: `${partPath}:${paragraphIndex}`,
        partPath,
        paragraphIndex,
        partLabel: partPath === 'word/document.xml'
          ? 'Document body'
          : partPath === 'word/bb1-standard-header.xml'
            ? 'Barangay header'
            : partPath.includes('/header') ? `Header ${partPath.match(/header(\d+)/)?.[1] || ''}` : `Footer ${partPath.match(/footer(\d+)/)?.[1] || ''}`,
        text,
        originalText: text,
        style,
        originalStyle: { ...style },
      })
    })
  }
  const images = []
  for (const [path, entry] of Object.entries(zip.files)) {
    if (entry.dir || !path.startsWith('word/media/')) continue
    const mimeType = getCertificateEditorImageMimeType(path)
    if (!mimeType) continue
    images.push({
      path,
      mimeType,
      dataUrl: `data:${mimeType};base64,${await entry.async('base64')}`,
    })
  }
  return { paragraphs, images }
}

const setCertificateEditorProperty = (documentXml, parent, propertyName, enabled) => {
  let property = getWordRunProperty(parent, propertyName)
  if (!enabled) {
    property?.parentNode.removeChild(property)
    return null
  }
  if (!property) {
    property = documentXml.createElementNS(wordNamespace, `w:${propertyName}`)
    const order = parent.localName === 'pPr'
      ? ['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr', 'suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap', 'overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange']
      : ['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline', 'shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w', 'kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign', 'rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange']
    const propertyRank = order.indexOf(propertyName)
    const nextProperty = Array.from(parent.children).find((child) => {
      if (child.namespaceURI !== wordNamespace) return false
      const childRank = order.indexOf(child.localName)
      return childRank >= 0 && (propertyRank < 0 || childRank > propertyRank)
    })
    parent.insertBefore(property, nextProperty || null)
  }
  return property
}

const updateCertificateEditorParagraph = (documentXml, paragraph, edit) => {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  const value = String(edit.text ?? '').replace(/\r?\n/g, ' ').slice(0, 10000)
  if (!textNodes.length && value) {
    let run = Array.from(paragraph.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'r')
    if (!run) {
      run = documentXml.createElementNS(wordNamespace, 'w:r')
      paragraph.appendChild(run)
    }
    const textNode = documentXml.createElementNS(wordNamespace, 'w:t')
    run.appendChild(textNode)
    textNodes.push(textNode)
  }
  textNodes.forEach((textNode, index) => setRunText(textNode, index === 0 ? value : ''))

  if (['left', 'center', 'right', 'both'].includes(edit.alignment)) {
    let paragraphProperties = Array.from(paragraph.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
    if (!paragraphProperties) {
      paragraphProperties = documentXml.createElementNS(wordNamespace, 'w:pPr')
      paragraph.insertBefore(paragraphProperties, paragraph.firstChild)
    }
    setCertificateEditorProperty(documentXml, paragraphProperties, 'jc', true)
      .setAttributeNS(wordNamespace, 'w:val', edit.alignment)
  }

  const runs = new Set(textNodes.map((textNode) => {
    let ancestor = textNode.parentNode
    while (ancestor && ancestor !== paragraph && !(ancestor.namespaceURI === wordNamespace && ancestor.localName === 'r')) {
      ancestor = ancestor.parentNode
    }
    return ancestor
  }).filter(Boolean))
  runs.forEach((run) => {
    let runProperties = Array.from(run.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    if (!runProperties) {
      runProperties = documentXml.createElementNS(wordNamespace, 'w:rPr')
      run.insertBefore(runProperties, run.firstChild)
    }
    if (edit.fontName) {
      const fonts = setCertificateEditorProperty(documentXml, runProperties, 'rFonts', true)
      for (const script of ['ascii', 'hAnsi', 'eastAsia', 'cs']) {
        fonts.setAttributeNS(wordNamespace, `w:${script}`, edit.fontName.slice(0, 80))
      }
    }
    if (edit.fontSize) {
      const size = Math.round(Number(edit.fontSize) * 2)
      if (Number.isFinite(size) && size >= 12 && size <= 192) {
        for (const propertyName of ['sz', 'szCs']) {
          setCertificateEditorProperty(documentXml, runProperties, propertyName, true)
            .setAttributeNS(wordNamespace, 'w:val', String(size))
        }
      }
    }
    if (/^#[\da-f]{6}$/i.test(edit.color || '')) {
      setCertificateEditorProperty(documentXml, runProperties, 'color', true)
        .setAttributeNS(wordNamespace, 'w:val', edit.color.slice(1).toUpperCase())
    }
    for (const [propertyName, enabled] of [['b', edit.bold], ['i', edit.italic], ['u', edit.underline]]) {
      if (enabled === undefined || enabled === null) continue
      const property = setCertificateEditorProperty(documentXml, runProperties, propertyName, enabled)
      if (property && propertyName === 'u') property.setAttributeNS(wordNamespace, 'w:val', 'single')
    }
    if (!runProperties.children.length) run.removeChild(runProperties)
  })
}

export const updateCertificateTemplateDocx = async (documentBlob, { paragraphs = [], imageFiles = [] }) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const groupedEdits = new Map()
  paragraphs.forEach((edit) => {
    if (!edit || typeof edit.partPath !== 'string' || !certificateEditorPartPathPattern.test(edit.partPath)
      || !Number.isInteger(edit.paragraphIndex)) {
      throw new Error('The template editor received an invalid paragraph location.')
    }
    const edits = groupedEdits.get(edit.partPath) || []
    edits.push(edit)
    groupedEdits.set(edit.partPath, edits)
  })
  for (const [partPath, edits] of groupedEdits) {
    const partFile = zip.file(partPath)
    if (!partFile) throw new Error(`The DOCX file is missing "${partPath}".`)
    const xml = new DOMParser().parseFromString(await partFile.async('text'), 'application/xml')
    if (xml.getElementsByTagName('parsererror').length) {
      throw new Error(`The DOCX part "${partPath}" contains invalid Word XML.`)
    }
    const wordParagraphs = getWordParagraphs(xml)
    edits.forEach((edit) => {
      const paragraph = wordParagraphs[edit.paragraphIndex]
      if (!paragraph) throw new Error(`The DOCX part "${partPath}" is missing paragraph ${edit.paragraphIndex + 1}.`)
      updateCertificateEditorParagraph(xml, paragraph, edit)
    })
    zip.file(partPath, new XMLSerializer().serializeToString(xml))
  }
  for (const imageFile of imageFiles) {
    if (!imageFile || typeof imageFile.path !== 'string' || !imageFile.path.startsWith('word/media/')
      || typeof imageFile.contentBase64 !== 'string' || !imageFile.contentBase64
      || getCertificateEditorImageMimeType(imageFile.path) !== imageFile.mimeType) {
      throw new Error('Replacement images must use PNG, JPEG, or GIF format matching the original image file.')
    }
    if (!zip.file(imageFile.path)) throw new Error(`The DOCX file is missing image "${imageFile.path}".`)
    zip.file(imageFile.path, imageFile.contentBase64, { base64: true })
  }
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

const setParagraphText = (paragraph, value) => {
  const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
  if (!textNodes.length) throw new Error('A certificate signatory line has no text run.')
  setRunText(textNodes[0], value)
  textNodes.slice(1).forEach((textNode) => setRunText(textNode, ''))
  Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'tab'))
    .forEach((tab) => tab.parentNode.removeChild(tab))
}

const formatRightCenteredSignatoryLine = (paragraph, documentXml) => {
  let properties = Array.from(paragraph.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
  if (!properties) {
    properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
    paragraph.insertBefore(properties, paragraph.firstChild)
  }

  Array.from(properties.children)
    .filter((child) => child.namespaceURI === wordNamespace && child.localName === 'ind')
    .forEach((indentation) => properties.removeChild(indentation))

  let alignment = Array.from(properties.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'jc')
  if (!alignment) {
    alignment = documentXml.createElementNS(wordNamespace, 'w:jc')
    properties.appendChild(alignment)
  }
  alignment.setAttributeNS(wordNamespace, 'w:val', 'center')
}

const setSignatoryParagraphFlow = (paragraph, documentXml, keepNext) => {
  let properties = Array.from(paragraph.children)
    .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
  if (!properties) {
    properties = documentXml.createElementNS(wordNamespace, 'w:pPr')
    paragraph.insertBefore(properties, paragraph.firstChild)
  }
  if (!Array.from(properties.children).some((child) => child.namespaceURI === wordNamespace && child.localName === 'keepLines')) {
    properties.appendChild(documentXml.createElementNS(wordNamespace, 'w:keepLines'))
  }
  if (keepNext && !Array.from(properties.children).some((child) => child.namespaceURI === wordNamespace && child.localName === 'keepNext')) {
    properties.appendChild(documentXml.createElementNS(wordNamespace, 'w:keepNext'))
  }
}

const createSignatoryRoleTable = (
  documentXml,
  roleSource,
  viceSource,
  viceTitle,
  phoneNumber = '',
  phoneSource = viceSource,
) => {
  const table = documentXml.createElementNS(wordNamespace, 'w:tbl')
  const properties = documentXml.createElementNS(wordNamespace, 'w:tblPr')
  const tableWidth = documentXml.createElementNS(wordNamespace, 'w:tblW')
  tableWidth.setAttributeNS(wordNamespace, 'w:w', '5000')
  tableWidth.setAttributeNS(wordNamespace, 'w:type', 'pct')
  properties.appendChild(tableWidth)
  const alignment = documentXml.createElementNS(wordNamespace, 'w:jc')
  alignment.setAttributeNS(wordNamespace, 'w:val', 'center')
  properties.appendChild(alignment)
  const layout = documentXml.createElementNS(wordNamespace, 'w:tblLayout')
  layout.setAttributeNS(wordNamespace, 'w:type', 'fixed')
  properties.appendChild(layout)
  const borders = documentXml.createElementNS(wordNamespace, 'w:tblBorders')
  ;['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].forEach((edge) => {
    const border = documentXml.createElementNS(wordNamespace, `w:${edge}`)
    border.setAttributeNS(wordNamespace, 'w:val', 'nil')
    borders.appendChild(border)
  })
  properties.appendChild(borders)
  table.appendChild(properties)

  const grid = documentXml.createElementNS(wordNamespace, 'w:tblGrid')
  const column = documentXml.createElementNS(wordNamespace, 'w:gridCol')
  column.setAttributeNS(wordNamespace, 'w:w', '9360')
  grid.appendChild(column)
  table.appendChild(grid)

  const addRow = (value, sourceParagraph) => {
    const row = documentXml.createElementNS(wordNamespace, 'w:tr')
    const rowProperties = documentXml.createElementNS(wordNamespace, 'w:trPr')
    rowProperties.appendChild(documentXml.createElementNS(wordNamespace, 'w:cantSplit'))
    row.appendChild(rowProperties)
    const cell = documentXml.createElementNS(wordNamespace, 'w:tc')
    const cellProperties = documentXml.createElementNS(wordNamespace, 'w:tcPr')
    const cellWidth = documentXml.createElementNS(wordNamespace, 'w:tcW')
    cellWidth.setAttributeNS(wordNamespace, 'w:w', '9360')
    cellWidth.setAttributeNS(wordNamespace, 'w:type', 'dxa')
    cellProperties.appendChild(cellWidth)
    cell.appendChild(cellProperties)

    const paragraph = documentXml.createElementNS(wordNamespace, 'w:p')
    const paragraphProperties = documentXml.createElementNS(wordNamespace, 'w:pPr')
    const alignment = documentXml.createElementNS(wordNamespace, 'w:jc')
    alignment.setAttributeNS(wordNamespace, 'w:val', 'center')
    paragraphProperties.appendChild(alignment)
    paragraphProperties.appendChild(documentXml.createElementNS(wordNamespace, 'w:keepLines'))
    paragraph.appendChild(paragraphProperties)

    const sourceRun = sourceParagraph?.getElementsByTagNameNS(wordNamespace, 'r')[0]
    const sourceRunProperties = Array.from(sourceRun?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
    const run = documentXml.createElementNS(wordNamespace, 'w:r')
    if (sourceRunProperties) run.appendChild(sourceRunProperties.cloneNode(true))
    const textNode = documentXml.createElementNS(wordNamespace, 'w:t')
    setRunText(textNode, value)
    run.appendChild(textNode)
    paragraph.appendChild(run)
    cell.appendChild(paragraph)
    row.appendChild(cell)
    table.appendChild(row)
  }

  addRow('Punong Barangay', roleSource)
  addRow(viceTitle, viceSource)
  if (phoneNumber) addRow(phoneNumber, phoneSource)
  return table
}

const setCertificateSignatory = (documentXml, documentName) => {
  const paragraphs = getWordParagraphs(documentXml)
  const signatoryIndex = paragraphs.findIndex((paragraph) => /BENEDICTO/i.test(getParagraphText(paragraph)))
  if (signatoryIndex < 0) throw new Error(`The "${documentName}" template is missing its barangay signatory.`)

  const isViceTitle = (text) => /(?:vice\s+abc|abc\s+vice)[\s-]+president/i.test(text)
  const nameParagraph = paragraphs[signatoryIndex]
  const signatoryText = getParagraphText(nameParagraph).trim()
  const name = signatoryText.replace(/punong\s*barangay/ig, '').replace(/(?:vice\s+abc|abc\s+vice)[\s-]+president/ig, '').trim()
  if (!name) throw new Error(`The "${documentName}" template has an empty barangay signatory name.`)

  const roleParagraph = paragraphs.slice(signatoryIndex + 1)
    .find((paragraph) => /punong\s*barangay|barangay\s+captain/i.test(getParagraphText(paragraph))) || null
  const existingViceParagraph = paragraphs.slice(signatoryIndex + 1)
    .find((paragraph) => isViceTitle(getParagraphText(paragraph))) || null
  const phoneParagraph = documentName === 'Certificate of Indigency'
    ? paragraphs.slice(signatoryIndex + 1)
      .find((paragraph) => /\b\d{3,4}[- ]\d{3}[- ]\d{4}\b/.test(getParagraphText(paragraph))) || null
    : null
  const phoneNumber = phoneParagraph ? getParagraphText(phoneParagraph).trim() : ''

  setParagraphText(nameParagraph, name)
  const signatoryRoleParagraph = roleParagraph
    || (existingViceParagraph || nameParagraph).cloneNode(true)
  const signatoryRoleTable = createSignatoryRoleTable(
    documentXml,
    roleParagraph || signatoryRoleParagraph,
    existingViceParagraph || signatoryRoleParagraph,
    'ABC Vice President',
    phoneNumber,
    phoneParagraph || existingViceParagraph || signatoryRoleParagraph,
  )
  nameParagraph.parentNode.insertBefore(signatoryRoleTable, nameParagraph.nextSibling)
  if (signatoryRoleParagraph.parentNode) {
    signatoryRoleParagraph.parentNode.removeChild(signatoryRoleParagraph)
  }
  if (existingViceParagraph?.parentNode && existingViceParagraph !== signatoryRoleParagraph) {
    existingViceParagraph.parentNode.removeChild(existingViceParagraph)
  }
  if (phoneParagraph?.parentNode && phoneParagraph !== signatoryRoleParagraph && phoneParagraph !== existingViceParagraph) {
    phoneParagraph.parentNode.removeChild(phoneParagraph)
  }
  formatRightCenteredSignatoryLine(nameParagraph, documentXml)
  setSignatoryParagraphFlow(nameParagraph, documentXml, true)
}

const movePunongBarangayBelowAbc = (documentXml) => {
  const paragraphs = getWordParagraphs(documentXml)
  const normalize = (paragraph) => getParagraphText(paragraph).trim().replace(/\s+/g, ' ')
  const viceParagraph = [...paragraphs].reverse()
    .find((paragraph) => /^(?:ABC\s+Vice|Vice\s+ABC)[\s-]+President$/i.test(normalize(paragraph)))
  const roleParagraph = [...paragraphs].reverse()
    .find((paragraph) => /^(?:Punong\s+Barangay|Barangay\s+Captain)$/i.test(normalize(paragraph)))
  if (
    !viceParagraph
    || !roleParagraph
    || roleParagraph.parentNode !== viceParagraph.parentNode
  ) return

  const roleIndex = paragraphs.indexOf(roleParagraph)
  const viceIndex = paragraphs.indexOf(viceParagraph)
  const phoneParagraph = paragraphs.slice(Math.max(roleIndex, viceIndex) + 1, Math.max(roleIndex, viceIndex) + 4)
    .find((paragraph) => /\b\d{3,4}[- ]\d{3}[- ]\d{4}\b/.test(normalize(paragraph))) || null
  const signatoryName = paragraphs.slice(0, Math.min(roleIndex, viceIndex)).reverse()
    .find((paragraph) => /BENEDICTO/i.test(normalize(paragraph)))

  const roleTable = createSignatoryRoleTable(
    documentXml,
    roleParagraph,
    viceParagraph,
    'ABC Vice President',
    phoneParagraph ? normalize(phoneParagraph) : '',
    phoneParagraph || viceParagraph,
  )
  if (signatoryName && signatoryName.parentNode === roleParagraph.parentNode) {
    roleParagraph.parentNode.insertBefore(roleTable, signatoryName.nextSibling)
  } else {
    roleParagraph.parentNode.insertBefore(roleTable, roleParagraph)
  }
  roleParagraph.parentNode.removeChild(roleParagraph)
  if (viceParagraph.parentNode && viceParagraph !== roleParagraph) {
    viceParagraph.parentNode.removeChild(viceParagraph)
  }
  if (phoneParagraph?.parentNode && phoneParagraph !== roleParagraph && phoneParagraph !== viceParagraph) {
    phoneParagraph.parentNode.removeChild(phoneParagraph)
  }
  if (signatoryName) setSignatoryParagraphFlow(signatoryName, documentXml, true)
}

export const getCertificateHeaderDrawingPositions = async (documentBlob) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('The certificate template is missing its main Word document.')

  const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template contains invalid Word XML.')
  }
  if (!documentXml.getElementsByTagNameNS(wordNamespace, 'headerReference').length) return []
  const { headerXml } = await getCertificateHeaderFile(zip, documentXml)

  return Array.from(headerXml.getElementsByTagNameNS(drawingNamespace, 'anchor'))
    .filter((anchor) => anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip').length)
    .map((anchor) => {
      const readPosition = (axis) => {
        const position = anchor.getElementsByTagNameNS(drawingNamespace, `position${axis}`)[0]
        const offset = position?.getElementsByTagNameNS(drawingNamespace, 'posOffset')[0]
        return {
          relativeFrom: position?.getAttribute('relativeFrom') || '',
          offset: offset ? Number(offset.textContent) / 9525 : 0,
        }
      }

      const description = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]?.getAttribute('descr') || ''
      return {
        description,
        horizontal: readPosition('H'),
        vertical: readPosition('V'),
        isWatermark: /BB1 LOGO WATERMARK/i.test(description),
        isGreenLogo: /BB1 LOGO/i.test(description) && !/WATERMARK/i.test(description),
      }
    })
}

export const getCertificateTemplateHeaderArtwork = async (documentBlob) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('The certificate template is missing its main Word document.')

  const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template contains invalid Word XML.')
  }
  const { headerFile, headerXml } = await getCertificateHeaderFile(zip, documentXml)
  const headerRelationshipsPath = headerFile.name.replace(/([^/]+)$/, '_rels/$1.rels')
  const headerRelationshipsFile = zip.file(headerRelationshipsPath)
  if (!headerRelationshipsFile) throw new Error('The certificate template header is missing its image relationships.')

  const relationshipsXml = new DOMParser().parseFromString(await headerRelationshipsFile.async('text'), 'application/xml')
  if (relationshipsXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template contains invalid header relationships.')
  }
  const relationships = Array.from(relationshipsXml.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
  const anchors = Array.from(headerXml.getElementsByTagNameNS(drawingNamespace, 'anchor'))
    .filter((anchor) => anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip').length)
    .filter((anchor) => {
      const description = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]?.getAttribute('descr') || ''
      return !/WATERMARK/i.test(description)
    })

  const images = await Promise.all(anchors.map(async (anchor) => {
    const imageRelationshipId = anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip')[0]
      ?.getAttributeNS(relationshipsNamespace, 'embed')
    const relationship = relationships.find((entry) => entry.getAttribute('Id') === imageRelationshipId)
    if (!relationship) throw new Error('A certificate template header image relationship could not be found.')
    const imageTarget = relationship.getAttribute('Target').replace(/^\/+/, '')
    const imagePath = imageTarget.startsWith('word/') ? imageTarget : `word/${imageTarget}`
    const imageFile = zip.file(imagePath)
    if (!imageFile) throw new Error('A certificate template header image could not be found.')
    const extension = imagePath.split('.').pop()?.toLowerCase()
    const mimeType = extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg' : `image/${extension || 'png'}`
    const description = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]?.getAttribute('descr') || ''
    return {
      src: `data:${mimeType};base64,${await imageFile.async('base64')}`,
      isGreenLogo: /BB1 LOGO/i.test(description) && !/WATERMARK/i.test(description),
    }
  }))
  const lines = Array.from(headerXml.getElementsByTagNameNS(wordNamespace, 'p'))
    .map((paragraph) => {
      const text = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
        .map((textNode) => textNode.textContent || '')
        .join('')
      const runProperties = paragraph.getElementsByTagNameNS(wordNamespace, 'rPr')[0]
      const fonts = runProperties?.getElementsByTagNameNS(wordNamespace, 'rFonts')[0]
      const fontSize = runProperties?.getElementsByTagNameNS(wordNamespace, 'sz')[0]?.getAttributeNS(wordNamespace, 'val')
      return {
        text,
        fontFamily: fonts?.getAttributeNS(wordNamespace, 'ascii') || '',
        fontSizePt: fontSize ? Number(fontSize) / 2 : 14,
        isBold: Boolean(runProperties?.getElementsByTagNameNS(wordNamespace, 'b').length),
      }
    })
    .filter((line) => line.text)

  return { images, lines }
}

export const getCertificateFitTextSettings = async (documentBlob) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error('The certificate template is missing its main Word document.')
  const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error('The certificate template contains invalid Word XML.')
  }

  return getWordParagraphs(documentXml).flatMap((paragraph) => {
    const paragraphText = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
      .map((textNode) => textNode.textContent || '')
      .join('')
    return Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'r'))
      .map((run) => {
        const fitText = run.getElementsByTagNameNS(wordNamespace, 'fitText')[0]
        const runText = Array.from(run.getElementsByTagNameNS(wordNamespace, 't'))
          .map((textNode) => textNode.textContent || '')
          .join('')
        const width = Number(fitText?.getAttributeNS(wordNamespace, 'val'))
        if (!fitText || !runText || !width) return null
        return { paragraphText, runText, width: width / 15 }
      })
      .filter(Boolean)
  })
}

const positionCertificateBodyLogos = (documentXml, documentName) => {
  const anchors = Array.from(documentXml.getElementsByTagNameNS(drawingNamespace, 'anchor'))
  const imageAnchors = anchors
    .map((anchor) => ({
      anchor,
      properties: anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0],
      extent: anchor.getElementsByTagNameNS(drawingNamespace, 'extent')[0],
    }))
    .filter(({ anchor, extent }) => (
      extent && anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip').length
    ))
  if (!imageAnchors.length) return

  const pageSize = documentXml.getElementsByTagNameNS(wordNamespace, 'pgSz')[0]
  const pageWidth = Number(pageSize?.getAttributeNS(wordNamespace, 'w')) * 635
  const pageHeight = Number(pageSize?.getAttributeNS(wordNamespace, 'h')) * 635
  if (!pageWidth || !pageHeight) {
    throw new Error(`The "${documentName}" template is missing its page dimensions for logo positioning.`)
  }

  imageAnchors.forEach(({ anchor, properties, extent }) => {
    const originalWidth = Number(extent.getAttribute('cx'))
    const originalHeight = Number(extent.getAttribute('cy'))
    if (!originalWidth || !originalHeight) return
    const description = `${properties?.getAttribute('descr') || ''} ${properties?.getAttribute('title') || ''}`
    const aspectRatio = originalWidth / originalHeight
    const isLarge = originalWidth >= pageWidth * 0.42 || originalHeight >= pageHeight * 0.28
    const looksLikeLogo = /logo|seal|emblem|watermark/i.test(description)
      || (aspectRatio >= 0.55 && aspectRatio <= 1.8)
    if (!isLarge || !looksLikeLogo) return

    let watermarkWidth = pageWidth * 0.62
    let watermarkHeight = watermarkWidth / aspectRatio
    if (watermarkHeight > pageHeight * 0.72) {
      watermarkHeight = pageHeight * 0.72
      watermarkWidth = watermarkHeight * aspectRatio
    }
    extent.setAttribute('cx', String(Math.round(watermarkWidth)))
    extent.setAttribute('cy', String(Math.round(watermarkHeight)))

    const setPosition = (axis, offset) => {
      const positionName = `position${axis}`
      let position = anchor.getElementsByTagNameNS(drawingNamespace, positionName)[0]
      if (!position) {
        position = documentXml.createElementNS(drawingNamespace, `wp:${positionName}`)
        const nextPosition = axis === 'H'
          ? anchor.getElementsByTagNameNS(drawingNamespace, 'positionV')[0]
            || anchor.getElementsByTagNameNS(drawingNamespace, 'extent')[0]
          : anchor.getElementsByTagNameNS(drawingNamespace, 'extent')[0]
        anchor.insertBefore(position, nextPosition || null)
      }
      position.setAttribute('relativeFrom', 'page')
      let positionOffset = position.getElementsByTagNameNS(drawingNamespace, 'posOffset')[0]
      if (!positionOffset) {
        positionOffset = documentXml.createElementNS(drawingNamespace, 'wp:posOffset')
        position.insertBefore(positionOffset, position.firstChild)
      }
      positionOffset.textContent = String(Math.round(offset))
    }

    setPosition('H', (pageWidth - watermarkWidth) / 2)
    setPosition('V', (pageHeight - watermarkHeight) / 2)
    anchor.setAttribute('behindDoc', '1')
    anchor.setAttribute('relativeHeight', '0')
    anchor.setAttribute('allowOverlap', '1')
    anchor.setAttribute('layoutInCell', '1')
    Array.from(anchor.children)
      .filter((child) => child.namespaceURI === drawingNamespace && child.localName.startsWith('wrap'))
      .forEach((wrap) => anchor.removeChild(wrap))
    const wrap = documentXml.createElementNS(drawingNamespace, 'wp:wrapNone')
    const drawingProperties = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]
    anchor.insertBefore(wrap, drawingProperties || null)

    if (properties) {
      properties.setAttribute('descr', 'BB1 LOGO WATERMARK')
      properties.setAttribute('title', 'BB1 Logo Watermark')
    }
    const image = anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip')[0]
    let opacity = image.getElementsByTagNameNS(drawingMainNamespace, 'alphaModFix')[0]
    if (!opacity) {
      opacity = documentXml.createElementNS(drawingMainNamespace, 'a:alphaModFix')
      image.appendChild(opacity)
    }
    opacity.setAttribute('amt', '18000')
  })
}

const positionGreenHeaderLogo = (headerXml, documentXml, documentName) => {
  const pageSize = documentXml.getElementsByTagNameNS(wordNamespace, 'pgSz')[0]
  const pageMargins = documentXml.getElementsByTagNameNS(wordNamespace, 'pgMar')[0]
  const pageWidth = Number(pageSize?.getAttributeNS(wordNamespace, 'w'))
  const leftMargin = Number(pageMargins?.getAttributeNS(wordNamespace, 'left'))
  const rightMargin = Number(pageMargins?.getAttributeNS(wordNamespace, 'right'))
  if (!pageWidth || !Number.isFinite(leftMargin) || !Number.isFinite(rightMargin)) {
    throw new Error(`The "${documentName}" template is missing its page margins.`)
  }

  const anchors = Array.from(headerXml.getElementsByTagNameNS(drawingNamespace, 'anchor'))
  const greenLogo = anchors.find((anchor) => {
    const description = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]?.getAttribute('descr') || ''
    return /BB1 LOGO/i.test(description) && !/WATERMARK/i.test(description)
  })
  if (!greenLogo) throw new Error(`The "${documentName}" template does not contain its green header logo.`)
  const redLogo = anchors.find((anchor) => {
    const description = anchor.getElementsByTagNameNS(drawingNamespace, 'docPr')[0]?.getAttribute('descr') || ''
    return anchor !== greenLogo
      && !/WATERMARK/i.test(description)
      && anchor.getElementsByTagNameNS(drawingMainNamespace, 'blip').length
  })
  if (!redLogo) throw new Error(`The "${documentName}" template does not contain its red header logo.`)

  const width = Number(greenLogo.getElementsByTagNameNS(drawingNamespace, 'extent')[0]?.getAttribute('cx'))
  if (!width) throw new Error(`The "${documentName}" green logo has invalid dimensions.`)
  const redPosition = redLogo.getElementsByTagNameNS(drawingNamespace, 'positionH')[0]
  const redOffset = Number(redPosition?.getElementsByTagNameNS(drawingNamespace, 'posOffset')[0]?.textContent)
  if (!redPosition || !Number.isFinite(redOffset)) {
    throw new Error(`The "${documentName}" red logo is missing its horizontal position.`)
  }
  const horizontalOffset = Math.round(
    pageWidth * 635 - rightMargin * 635 - (redOffset - leftMargin * 635) - width,
  )

  const setPosition = (position, relativeFrom, offset, axis) => {
    const positionOffset = position?.getElementsByTagNameNS(drawingNamespace, 'posOffset')[0]
    if (!position || !positionOffset) {
      throw new Error(`The "${documentName}" green logo is missing its ${axis.toLowerCase()} position.`)
    }
    position.setAttribute('relativeFrom', relativeFrom)
    positionOffset.textContent = String(offset)
  }
  const horizontalPosition = greenLogo.getElementsByTagNameNS(drawingNamespace, 'positionH')[0]
  const verticalPosition = greenLogo.getElementsByTagNameNS(drawingNamespace, 'positionV')[0]
  const redVerticalPosition = redLogo.getElementsByTagNameNS(drawingNamespace, 'positionV')[0]
  const verticalOffset = Number(redVerticalPosition?.getElementsByTagNameNS(drawingNamespace, 'posOffset')[0]?.textContent)
  if (!redVerticalPosition || !Number.isFinite(verticalOffset)) {
    throw new Error(`The "${documentName}" red logo is missing its vertical position.`)
  }
  setPosition(horizontalPosition, 'page', horizontalOffset, 'horizontal')
  setPosition(verticalPosition, redVerticalPosition.getAttribute('relativeFrom'), verticalOffset, 'vertical')
}

const headerRelationshipType = `${relationshipsNamespace}/header`
const imageRelationshipType = `${relationshipsNamespace}/image`
const standardHeaderPartName = 'word/bb1-standard-header.xml'
let standardHeaderPartsPromise

const resolveDocxPartPath = (basePart, target) => {
  const parts = target.startsWith('/') ? [] : basePart.split('/').slice(0, -1)
  target.replace(/^\/+/, '').split('/').forEach((part) => {
    if (!part || part === '.') return
    if (part === '..') parts.pop()
    else parts.push(part)
  })
  return parts.join('/')
}

const getStandardHeaderParts = async () => {
  if (!standardHeaderPartsPromise) {
    standardHeaderPartsPromise = (async () => {
      const response = await fetch(certificateOfResidencyUrl)
      if (!response.ok) throw new Error(`The fixed certificate header could not be loaded (${response.status}).`)
      const zip = await JSZip.loadAsync(await response.arrayBuffer())
      const documentFile = zip.file('word/document.xml')
      if (!documentFile) throw new Error('The fixed certificate template is missing its main document.')
      const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
      const { headerFile, headerXml } = await getCertificateHeaderFile(zip, documentXml)
      Array.from(headerXml.getElementsByTagNameNS(wordNamespace, 'p')).forEach((paragraph) => {
        if (!Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
          .some((text) => (text.textContent || '').trim())) return
        let paragraphProperties = Array.from(paragraph.children)
          .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
        if (!paragraphProperties) {
          paragraphProperties = headerXml.createElementNS(wordNamespace, 'w:pPr')
          paragraph.insertBefore(paragraphProperties, paragraph.firstChild)
        }
        let justification = Array.from(paragraphProperties.children)
          .find((child) => child.namespaceURI === wordNamespace && child.localName === 'jc')
        if (!justification) {
          justification = headerXml.createElementNS(wordNamespace, 'w:jc')
          const runProperties = Array.from(paragraphProperties.children)
            .find((child) => child.namespaceURI === wordNamespace && child.localName === 'rPr')
          paragraphProperties.insertBefore(justification, runProperties || null)
        }
        justification.setAttributeNS(wordNamespace, 'w:val', 'center')
      })
      const relationshipsPath = headerFile.name.replace(/([^/]+)$/, '_rels/$1.rels')
      const relationshipsFile = zip.file(relationshipsPath)
      if (!relationshipsFile) throw new Error('The fixed certificate header is missing its image relationships.')
      const relationshipsXml = new DOMParser().parseFromString(await relationshipsFile.async('text'), 'application/xml')
      if (relationshipsXml.getElementsByTagName('parsererror').length) {
        throw new Error('The fixed certificate header has invalid image relationships.')
      }

      const imageAssets = await Promise.all(
        Array.from(relationshipsXml.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
          .filter((relationship) => relationship.getAttribute('Type') === imageRelationshipType)
          .map(async (relationship) => {
            const sourcePath = resolveDocxPartPath(headerFile.name, relationship.getAttribute('Target'))
            const sourceFile = zip.file(sourcePath)
            if (!sourceFile) throw new Error(`The fixed certificate header image ${sourcePath} is missing.`)
            return {
              id: relationship.getAttribute('Id'),
              extension: sourcePath.split('.').pop().toLowerCase(),
              data: await sourceFile.async('uint8array'),
            }
          }),
      )
      if (!imageAssets.length) throw new Error('The fixed certificate header has no logo images.')
      return {
        headerXml: new XMLSerializer().serializeToString(headerXml),
        relationshipsXml: new XMLSerializer().serializeToString(relationshipsXml),
        imageAssets,
      }
    })().catch((error) => {
      standardHeaderPartsPromise = null
      throw error
    })
  }
  return standardHeaderPartsPromise
}

const applyStandardCertificateHeader = async (zip, documentXml, documentName) => {
  const standardHeader = await getStandardHeaderParts()
  const relationshipsPath = 'word/_rels/document.xml.rels'
  let documentRelationships = zip.file(relationshipsPath)
    ? new DOMParser().parseFromString(await zip.file(relationshipsPath).async('text'), 'application/xml')
    : new DOMParser().parseFromString(`<Relationships xmlns="${packageRelationshipsNamespace}"/>`, 'application/xml')
  if (documentRelationships.getElementsByTagName('parsererror').length) {
    throw new Error(`The "${documentName}" template has invalid document relationships.`)
  }
  let headerRelationshipId = Array.from(documentRelationships.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
    .find((relationship) => relationship.getAttribute('Type') === headerRelationshipType
      && resolveDocxPartPath('word/document.xml', relationship.getAttribute('Target')) === standardHeaderPartName)
    ?.getAttribute('Id')
  if (!headerRelationshipId) {
    const existingIds = new Set(Array.from(documentRelationships.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship'))
      .map((relationship) => relationship.getAttribute('Id')))
    headerRelationshipId = 'rIdBB1StandardHeader'
    let suffix = 1
    while (existingIds.has(headerRelationshipId)) {
      headerRelationshipId = `rIdBB1StandardHeader${suffix}`
      suffix += 1
    }
    const relationship = documentRelationships.createElementNS(packageRelationshipsNamespace, 'Relationship')
    relationship.setAttribute('Id', headerRelationshipId)
    relationship.setAttribute('Type', headerRelationshipType)
    relationship.setAttribute('Target', 'bb1-standard-header.xml')
    documentRelationships.documentElement.appendChild(relationship)
  }

  const headerRelationships = new DOMParser().parseFromString(standardHeader.relationshipsXml, 'application/xml')
  const mediaPaths = new Map()
  standardHeader.imageAssets.forEach(({ id, extension, data }) => {
    const safeId = id.replace(/[^a-z0-9_-]/gi, '')
    const target = `media/bb1-standard-header-${safeId}.${extension}`
    zip.file(`word/${target}`, data)
    mediaPaths.set(id, target)
  })
  Array.from(headerRelationships.getElementsByTagNameNS(packageRelationshipsNamespace, 'Relationship')).forEach((relationship) => {
    if (relationship.getAttribute('Type') !== imageRelationshipType) return
    const target = mediaPaths.get(relationship.getAttribute('Id'))
    if (!target) throw new Error('The fixed certificate header contains an unsupported image reference.')
    relationship.setAttribute('Target', target)
  })

  const headerXml = new DOMParser().parseFromString(standardHeader.headerXml, 'application/xml')
  if (headerXml.getElementsByTagName('parsererror').length) {
    throw new Error('The fixed certificate header contains invalid Word XML.')
  }
  const pageSize = documentXml.getElementsByTagNameNS(wordNamespace, 'pgSz')[0]
  const pageMargins = documentXml.getElementsByTagNameNS(wordNamespace, 'pgMar')[0]
  if (pageSize && pageMargins) {
    positionGreenHeaderLogo(headerXml, documentXml, documentName)
  }

  const relationshipNamespaceAttribute = 'http://www.w3.org/2000/xmlns/'
  if (!documentXml.documentElement.lookupPrefix(relationshipsNamespace)) {
    documentXml.documentElement.setAttributeNS(relationshipNamespaceAttribute, 'xmlns:r', relationshipsNamespace)
  }
  const sections = Array.from(documentXml.getElementsByTagNameNS(wordNamespace, 'sectPr'))
  if (!sections.length) {
    const body = documentXml.getElementsByTagNameNS(wordNamespace, 'body')[0]
    if (!body) throw new Error(`The "${documentName}" template has no Word document body.`)
    sections.push(documentXml.createElementNS(wordNamespace, 'w:sectPr'))
    body.appendChild(sections[0])
  }
  sections.forEach((section) => {
    Array.from(section.getElementsByTagNameNS(wordNamespace, 'headerReference'))
      .forEach((reference) => reference.parentNode.removeChild(reference))
    const firstFollowingSectionSetting = Array.from(section.children)
      .find((child) => child.namespaceURI === wordNamespace)
    ;['default', 'first', 'even'].forEach((type) => {
      const reference = documentXml.createElementNS(wordNamespace, 'w:headerReference')
      reference.setAttributeNS(wordNamespace, 'w:type', type)
      reference.setAttributeNS(relationshipsNamespace, 'r:id', headerRelationshipId)
      section.insertBefore(reference, firstFollowingSectionSetting || null)
    })
  })

  const contentTypes = zip.file('[Content_Types].xml')
  if (!contentTypes) throw new Error(`The "${documentName}" template has no content type manifest.`)
  const contentTypesXml = new DOMParser().parseFromString(await contentTypes.async('text'), 'application/xml')
  if (contentTypesXml.getElementsByTagName('parsererror').length) {
    throw new Error(`The "${documentName}" template has an invalid content type manifest.`)
  }
  const override = Array.from(contentTypesXml.getElementsByTagNameNS(packageContentTypesNamespace, 'Override'))
    .find((entry) => entry.getAttribute('PartName') === `/${standardHeaderPartName}`)
  const headerOverride = override || contentTypesXml.createElementNS(packageContentTypesNamespace, 'Override')
  headerOverride.setAttribute('PartName', `/${standardHeaderPartName}`)
  headerOverride.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml')
  if (!override) contentTypesXml.documentElement.appendChild(headerOverride)
  standardHeader.imageAssets.forEach(({ extension }) => {
    const hasExtension = Array.from(contentTypesXml.getElementsByTagNameNS(packageContentTypesNamespace, 'Default'))
      .some((entry) => entry.getAttribute('Extension').toLowerCase() === extension)
    if (!hasExtension) {
      const defaultType = contentTypesXml.createElementNS(packageContentTypesNamespace, 'Default')
      defaultType.setAttribute('Extension', extension)
      defaultType.setAttribute('ContentType', extension === 'png' ? 'image/png' : 'image/jpeg')
      contentTypesXml.documentElement.appendChild(defaultType)
    }
  })

  zip.file(standardHeaderPartName, new XMLSerializer().serializeToString(headerXml))
  zip.file('word/_rels/bb1-standard-header.xml.rels', new XMLSerializer().serializeToString(headerRelationships))
  zip.file(relationshipsPath, new XMLSerializer().serializeToString(documentRelationships))
  zip.file('[Content_Types].xml', new XMLSerializer().serializeToString(contentTypesXml))
}

export const normalizeCertificateTemplateHeader = async (documentBlob, documentName) => {
  const zip = await JSZip.loadAsync(documentBlob)
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error(`The "${documentName}" template is missing its main Word document.`)
  const documentXml = new DOMParser().parseFromString(await documentFile.async('text'), 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error(`The "${documentName}" template contains invalid Word XML.`)
  }
  await applyStandardCertificateHeader(zip, documentXml, documentName)
  zip.file('word/document.xml', new XMLSerializer().serializeToString(documentXml))
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

const hasCenteredStandardHeader = async (zip) => {
  const headerFile = zip.file(standardHeaderPartName)
  if (!headerFile) return false
  const headerXml = new DOMParser().parseFromString(await headerFile.async('text'), 'application/xml')
  if (headerXml.getElementsByTagName('parsererror').length) return false
  const textParagraphs = Array.from(headerXml.getElementsByTagNameNS(wordNamespace, 'p'))
    .filter((paragraph) => getParagraphText(paragraph).trim())
  return textParagraphs.length === 4 && textParagraphs.every((paragraph) => {
    const properties = Array.from(paragraph.children)
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'pPr')
    const justification = Array.from(properties?.children || [])
      .find((child) => child.namespaceURI === wordNamespace && child.localName === 'jc')
    return justification?.getAttributeNS(wordNamespace, 'val') === 'center'
  })
}

export const createFilledCertificateDocx = async (documentName, certificateData, customTemplates = []) => {
  const customTemplate = customTemplates.find((template) => template.name === documentName)
  if (customTemplate) {
    if (!customTemplate.contentBase64 || !Array.isArray(customTemplate.fields)) {
      throw new Error(`The uploaded "${documentName}" template is missing its DOCX data or field configuration.`)
    }
    const fileBytes = Uint8Array.from(atob(customTemplate.contentBase64), (character) => character.charCodeAt(0))
    let customZip = await JSZip.loadAsync(fileBytes)
    if (!customTemplate.preserveHeader && !await hasCenteredStandardHeader(customZip)) {
      const normalizedBlob = await normalizeCertificateTemplateHeader(fileBytes, documentName)
      customZip = await JSZip.loadAsync(normalizedBlob)
    }
    const customDocumentFile = customZip.file('word/document.xml')
    if (!customDocumentFile) throw new Error(`The uploaded "${documentName}" template has no main Word document.`)
    const customDocumentXml = new DOMParser().parseFromString(await customDocumentFile.async('text'), 'application/xml')
    if (customDocumentXml.getElementsByTagName('parsererror').length) {
      throw new Error(`The uploaded "${documentName}" template contains invalid Word XML.`)
    }
    enableCertificateTemplateTextWrapping(customDocumentXml)
    const customNumberingFile = customZip.file('word/numbering.xml')
    const customNumberingXml = customNumberingFile
      ? new DOMParser().parseFromString(await customNumberingFile.async('text'), 'application/xml')
      : null
    if (customNumberingXml?.getElementsByTagName('parsererror').length) {
      throw new Error(`The uploaded "${documentName}" template contains invalid list numbering data.`)
    }
    const customParagraphs = getWordParagraphs(customDocumentXml)
    const customReplacements = groupCertificateTemplateFields(customTemplate.fields)
      .flatMap((category) => {
        if (category.type === 'checkbox') {
          const categoryValue = certificateData[category.key]
          const selectedOptions = new Set([
            ...(Array.isArray(categoryValue) ? categoryValue : categoryValue ? [categoryValue] : []),
            ...category.targets
              .filter((target) => target.key !== category.key && certificateData[target.key])
              .map((target) => target.choiceLabel),
          ])
          return category.targets.map((target) => ({
            ...target,
            label: category.label,
            checkbox: true,
            checked: selectedOptions.has(target.choiceLabel),
          }))
        }
        const value = [
          certificateData[category.key],
          ...category.targets.map((target) => certificateData[target.key]),
        ].find((candidate) => String(candidate ?? '').trim())
        if (value === undefined) return []
        return category.targets.map((target) => ({
          ...target,
          label: category.label,
          value: category.type === 'date' && target.datePart
            ? formatCustomDatePart(value, target.datePart)
            : category.label === 'Purok'
              ? normalizeBarangayZone(value) || String(value).trim()
            : String(value).trim(),
        }))
      })
      .sort((first, second) => second.paragraph - first.paragraph
        || second.textNodeIndex - first.textNodeIndex
        || (second.placeholderStart || 0) - (first.placeholderStart || 0))
    customReplacements.filter((replacement) => replacement.numberedCheckbox).forEach((replacement) => {
      if (!customNumberingXml) {
        throw new Error(`The uploaded "${documentName}" template is missing its checkbox list definitions.`)
      }
      const paragraph = customParagraphs[replacement.paragraph]
      if (!paragraph) throw new Error(`The uploaded "${documentName}" template is missing the checkbox for ${replacement.choiceLabel}.`)
      setNumberedCheckboxState(
        customNumberingXml,
        paragraph,
        replacement,
        replacement.checked,
        documentName,
      )
    })
    customReplacements
      .filter((replacement) => Number.isInteger(replacement.checkboxControlIndex))
      .forEach((replacement) => {
        const paragraph = customParagraphs[replacement.paragraph]
        if (!paragraph) throw new Error(`The uploaded "${documentName}" template is missing checkbox paragraph ${replacement.paragraph + 1}.`)
        const checkboxControls = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 'sdt'))
          .filter((control) => control.getElementsByTagNameNS(wordCheckboxNamespace, 'checkbox').length)
        const control = checkboxControls[replacement.checkboxControlIndex]
        const checkboxProperties = control?.getElementsByTagNameNS(wordCheckboxNamespace, 'checkbox')[0]
        if (!control || !checkboxProperties) {
          throw new Error(`The uploaded "${documentName}" template is missing the checkbox for ${replacement.choiceLabel}.`)
        }
        let checkedProperty = Array.from(checkboxProperties.children)
          .find((child) => child.namespaceURI === wordCheckboxNamespace && child.localName === 'checked')
        if (!checkedProperty) {
          checkedProperty = customDocumentXml.createElementNS(wordCheckboxNamespace, 'w14:checked')
          checkboxProperties.insertBefore(checkedProperty, checkboxProperties.firstChild)
        }
        checkedProperty.setAttributeNS(wordCheckboxNamespace, 'w14:val', replacement.checked ? '1' : '0')
        const stateName = replacement.checked ? 'checkedState' : 'uncheckedState'
        const state = Array.from(checkboxProperties.children)
          .find((child) => child.namespaceURI === wordCheckboxNamespace && child.localName === stateName)
        const symbolCode = state?.getAttributeNS(wordCheckboxNamespace, 'val')
        const symbolFont = state?.getAttributeNS(wordCheckboxNamespace, 'font')
        Array.from(control.getElementsByTagNameNS(wordNamespace, 'sym')).forEach((symbol) => {
          if (symbolCode) symbol.setAttributeNS(wordNamespace, 'w:char', symbolCode)
          if (symbolFont) symbol.setAttributeNS(wordNamespace, 'w:font', symbolFont)
        })
        Array.from(control.getElementsByTagNameNS(wordNamespace, 't')).forEach((textNode) => {
          const originalGlyph = (textNode.textContent || '').match(/[☐□▫◻▢☑☒]/)?.[0]
          if (originalGlyph) setRunText(textNode, getCheckboxGlyph(originalGlyph, replacement.checked))
        })
      })
    const replacementsByTextNode = new Map()
    customReplacements.filter((field) => (
      !Number.isInteger(field.checkboxControlIndex) && !field.numberedCheckbox
    )).forEach((field) => {
      const key = `${field.paragraph}:${field.textNodeIndex}`
      const replacements = replacementsByTextNode.get(key) || []
      replacements.push(field)
      replacementsByTextNode.set(key, replacements)
    })
    const orderedReplacementGroups = Array.from(replacementsByTextNode.values())
      .sort((first, second) => second[0].paragraph - first[0].paragraph
        || second[0].textNodeIndex - first[0].textNodeIndex)

    orderedReplacementGroups.forEach((fieldsForTextNode) => {
      const field = fieldsForTextNode[0]
      const paragraph = customParagraphs[field.paragraph]
      if (!paragraph) throw new Error(`The uploaded "${documentName}" template is missing field paragraph ${field.paragraph + 1}.`)
      const textNode = paragraph.getElementsByTagNameNS(wordNamespace, 't')[field.textNodeIndex]
      if (fieldsForTextNode.every((replacement) => replacement.placeholder || replacement.checkbox)) {
        if (!textNode) throw new Error(`The uploaded "${documentName}" template is missing its fillable field for ${field.label}.`)
        let updatedText = textNode.textContent || ''
        fieldsForTextNode.forEach((replacement) => {
          if (replacement.placeholderSegments?.length > 1) {
            const paragraphTextNodes = paragraph.getElementsByTagNameNS(wordNamespace, 't')
            const segments = replacement.placeholderSegments
            const placeholderText = segments
              .map((segment) => (paragraphTextNodes[segment.textNodeIndex]?.textContent || '').slice(segment.start, segment.end))
              .join('')
            if (!isCertificateBlankPlaceholder(placeholderText)) {
              throw new Error(`The uploaded "${documentName}" template is missing its fillable field for ${replacement.label}.`)
            }
            const firstSegment = segments[0]
            const lastSegment = segments[segments.length - 1]
            const firstNode = paragraphTextNodes[firstSegment.textNodeIndex]
            const lastNode = paragraphTextNodes[lastSegment.textNodeIndex]
            removeRunFitText(firstNode)
            removeRunFitText(lastNode)
            const prefix = (firstNode.textContent || '').slice(0, firstSegment.start)
            const suffix = (lastNode.textContent || '').slice(lastSegment.end)
            const previousText = paragraphTextNodes[firstSegment.textNodeIndex - 1]?.textContent || ''
            const nextText = paragraphTextNodes[lastSegment.textNodeIndex + 1]?.textContent || ''
            const leadingSpace = /[\p{L}\p{N}]$/u.test(prefix || previousText) ? ' ' : ''
            const trailingSpace = /^[\p{L}\p{N}]/u.test(suffix || nextText) ? ' ' : ''
            const firstNodeValue = `${prefix}${leadingSpace}${replacement.value}`
            if (firstNode === textNode) {
              updatedText = firstNodeValue
              setRunText(textNode, updatedText)
            } else {
              setRunText(firstNode, firstNodeValue)
            }
            segments.slice(1, -1).forEach((segment) => setRunText(paragraphTextNodes[segment.textNodeIndex], ''))
            if (lastNode === textNode) {
              updatedText = `${trailingSpace}${suffix}`
              setRunText(textNode, updatedText)
            } else {
              setRunText(lastNode, `${trailingSpace}${suffix}`)
            }
            return
          }
          const placeholderText = updatedText.slice(replacement.placeholderStart, replacement.placeholderEnd)
          if (replacement.checkbox) {
            if (!/^[☐□▫◻▢☑☒]$/.test(placeholderText)) {
              throw new Error(`The uploaded "${documentName}" template is missing the checkbox for ${replacement.choiceLabel}.`)
            }
            updatedText = `${updatedText.slice(0, replacement.placeholderStart)}${getCheckboxGlyph(placeholderText, replacement.checked)}${updatedText.slice(replacement.placeholderEnd)}`
            return
          }
          if (!isCertificateBlankPlaceholder(placeholderText)) {
            throw new Error(`The uploaded "${documentName}" template is missing its fillable field for ${replacement.label}.`)
          }
          const prefix = updatedText.slice(0, replacement.placeholderStart)
          const suffix = updatedText.slice(replacement.placeholderEnd)
          const leadingSpace = /[\p{L}\p{N}]$/u.test(prefix) ? ' ' : ''
          const trailingSpace = /^[\p{L}\p{N}]/u.test(suffix) ? ' ' : ''
          updatedText = `${prefix}${leadingSpace}${replacement.value}${trailingSpace}${suffix}`
        })
        if (fieldsForTextNode.some((replacement) => replacement.placeholder)) {
          removeRunFitText(textNode)
        }
        setRunText(textNode, updatedText)
        return
      }
      if (fieldsForTextNode.length > 1) {
        throw new Error(`The uploaded "${documentName}" template has overlapping fields in paragraph ${field.paragraph + 1}.`)
      }
      let replacementTextNode = textNode
      if (!replacementTextNode && field.emptyTextBox) {
        const run = customDocumentXml.createElementNS(wordNamespace, 'w:r')
        replacementTextNode = customDocumentXml.createElementNS(wordNamespace, 'w:t')
        run.appendChild(replacementTextNode)
        paragraph.appendChild(run)
      }
      const targetText = replacementTextNode?.textContent || ''
      const placeholderMatch = field.placeholder
        ? targetText.match(/_{2,}|\.{3,}|-{3,}|–{3,}|—{3,}/)
        : null
      const isExpectedPlaceholder = field.emptyTextBox
        ? !targetText.trim()
        : field.placeholderText !== undefined
          ? targetText === field.placeholderText
          : field.placeholder
            ? Boolean(placeholderMatch && isCertificateBlankPlaceholder(placeholderMatch[0]))
            : /^\s*[,.]?\s*$/.test(targetText)
      if (!replacementTextNode || !isExpectedPlaceholder) {
        throw new Error(`The uploaded "${documentName}" template is missing its fillable field for ${field.label}.`)
      }
      if (field.emptyTextBox || field.placeholderText !== undefined) {
        let ancestor = replacementTextNode.parentNode
        while (ancestor && ancestor !== customDocumentXml.documentElement) {
          if (ancestor.namespaceURI === wordNamespace && ancestor.localName === 'sdt') {
            const properties = ancestor.getElementsByTagNameNS(wordNamespace, 'sdtPr')[0]
            Array.from(properties?.getElementsByTagNameNS(wordNamespace, 'showingPlcHdr') || [])
              .forEach((placeholder) => placeholder.parentNode.removeChild(placeholder))
            break
          }
          ancestor = ancestor.parentNode
        }
      }
      const textNodes = Array.from(paragraph.getElementsByTagNameNS(wordNamespace, 't'))
      const previousText = textNodes[textNodes.indexOf(replacementTextNode) - 1]?.textContent || ''
      const nextText = textNodes[textNodes.indexOf(replacementTextNode) + 1]?.textContent || ''
      const punctuation = field.placeholder ? '' : targetText.match(/[,.]/)?.[0] || ''
      const prefix = placeholderMatch ? targetText.slice(0, placeholderMatch.index) : ''
      const suffix = placeholderMatch
        ? targetText.slice(placeholderMatch.index + placeholderMatch[0].length)
        : ''
      const leadingSpace = /[\p{L}\p{N}]$/u.test(prefix || previousText) ? ' ' : ''
      const trailingSpace = /^[\p{L}\p{N}]/u.test(suffix || nextText) ? ' ' : ''
      replaceRunTextWithPlainText(
        replacementTextNode,
        `${prefix}${leadingSpace}`,
        field.value,
        `${punctuation}${trailingSpace}${suffix}`,
        true,
        true,
        0,
        Boolean(field.placeholder),
        true,
      )
    })
    movePunongBarangayBelowAbc(customDocumentXml)
    positionCertificateBodyLogos(customDocumentXml, documentName)
    if (customNumberingXml && customReplacements.some((replacement) => replacement.numberedCheckbox)) {
      customZip.file('word/numbering.xml', new XMLSerializer().serializeToString(customNumberingXml))
    }
    customZip.file('word/document.xml', new XMLSerializer().serializeToString(customDocumentXml))
    return customZip.generateAsync({
      type: 'blob',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
  }

  const template = templates[documentName]
  if (!template) throw new Error(`No DOCX template is configured for "${documentName}".`)

  const response = await fetch(template.file)
  if (!response.ok) throw new Error(`Unable to load the "${documentName}" DOCX template (${response.status}).`)

  const zip = await JSZip.loadAsync(await response.arrayBuffer())
  const documentFile = zip.file('word/document.xml')
  if (!documentFile) throw new Error(`The "${documentName}" DOCX template has no main Word document.`)

  const xml = await documentFile.async('text')
  const documentXml = new DOMParser().parseFromString(xml, 'application/xml')
  if (documentXml.getElementsByTagName('parsererror').length) {
    throw new Error(`The "${documentName}" DOCX template contains invalid Word XML.`)
  }

  const paragraphs = getWordParagraphs(documentXml)
  if (!shouldPreserveCertificateSourceLayout(documentName)) {
    normalizeResidencyUnderlineLengths(paragraphs, documentName)
  }
  template.blanks.forEach(({ paragraph: paragraphIndex, values }) => {
    const paragraph = paragraphs[paragraphIndex]
    if (!paragraph) throw new Error(`The "${documentName}" DOCX template is missing paragraph ${paragraphIndex + 1}.`)
    const replacements = []
    for (const [field, slot] of Object.entries(values)) {
      const value = !Array.isArray(slot) && typeof slot === 'object' && slot.render
        ? slot.render(certificateData)
        : certificateData[field]
      const entries = Array.isArray(slot) ? slot : [{
        slot: typeof slot === 'object' ? slot.slot : slot,
        part: '',
        afterText: typeof slot === 'object' ? slot.afterText : '',
        beforeLineBreak: typeof slot === 'object' ? slot.beforeLineBreak : false,
      }]
      const dateParts = fields[field]?.type === 'date' ? getDateParts(value) : {}
      entries.forEach(({ slot: slotIndex, part, afterText, beforeLineBreak }) => {
        if (beforeLineBreak) insertLineBreakBeforeBlank(paragraph, slotIndex, documentName, paragraphIndex)
        if (!String(value ?? '').trim() && !afterText) return
        replacements.push({
          slotIndex,
          value: part ? dateParts[part] : fields[field]?.type === 'date' ? formatDate(value) : value,
          afterText: afterText || (!Array.isArray(slot) && typeof slot === 'object' ? slot.afterText : ''),
        })
      })
    }
    replacements.sort((first, second) => second.slotIndex - first.slotIndex)
      .forEach(({ slotIndex, value, afterText }) => setBlankRun(paragraph, slotIndex, value, documentName, paragraphIndex, afterText))
  })

  template.replacements?.forEach(({ paragraph: paragraphIndex, from, value, allowEmpty, normalizePreviousSpace, removeFollowingSpace }) => {
    const paragraph = paragraphs[paragraphIndex]
    if (!paragraph) throw new Error(`The "${documentName}" DOCX template is missing paragraph ${paragraphIndex + 1}.`)
    const replacement = value(certificateData)
    if (replacement === null || replacement === undefined || (replacement === '' && !allowEmpty)) return
    replaceParagraphText(paragraph, from, replacement, documentName, normalizePreviousSpace, removeFollowingSpace)
  })

  splitPermitOwnerUnderline(documentXml, documentName, certificateData)

  if (documentName === 'Certificate of Indigency') {
    removeTrailingUnderlinedWhitespace(paragraphs[22])
  }

  template.checkboxes?.forEach(({ paragraph: paragraphIndex, value, choices, offset }) => {
    if (!certificateData[value]) return
    const paragraph = paragraphs[paragraphIndex]
    const selectedIndex = choices.indexOf(certificateData[value])
    if (paragraph) setParagraphCheckbox(paragraph, selectedIndex, offset || 0, choices.length)
  })

  if (template.checklist && certificateData[template.checklist.value]) {
    const checklistParagraphs = template.checklist.paragraphs.map((paragraphIndex) => paragraphs[paragraphIndex])
    if (checklistParagraphs.some((paragraph) => !paragraph)) {
      throw new Error(`The "${documentName}" DOCX template has an incomplete assistance checklist.`)
    }
    const numberingFile = zip.file('word/numbering.xml')
    if (!numberingFile) throw new Error(`The "${documentName}" template is missing its checkbox list definitions.`)
    const numberingXml = new DOMParser().parseFromString(await numberingFile.async('text'), 'application/xml')
    if (numberingXml.getElementsByTagName('parsererror').length) {
      throw new Error(`The "${documentName}" template contains invalid list numbering data.`)
    }
    setAssistanceChecklist(
      checklistParagraphs,
      certificateData[template.checklist.value],
      documentName,
      numberingXml,
    )
    zip.file('word/numbering.xml', new XMLSerializer().serializeToString(numberingXml))
  }

  setCertificateAppearanceLineLayout(documentXml, documentName)
  suppressCertificateAutoHyphenation(documentXml, documentName)
  setCertificateSignatory(documentXml, documentName)
  if (!shouldPreserveCertificateSourceLayout(documentName)) {
    await applyStandardCertificateHeader(zip, documentXml, documentName)
    adjustResidencyParagraphPosition(documentXml, documentName)
  }
  movePunongBarangayBelowAbc(documentXml)
  leftAlignFieldParagraphs(documentXml, documentName)
  positionCertificateBodyLogos(documentXml, documentName)
  zip.file('word/document.xml', new XMLSerializer().serializeToString(documentXml))
  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  })
}

export const downloadFilledCertificateDocx = async (documentName, certificateData, requestId, customTemplates = []) => {
  const blob = await createFilledCertificateDocx(documentName, certificateData, customTemplates)
  const objectUrl = URL.createObjectURL(blob)
  const link = window.document.createElement('a')
  const safeRequestId = String(requestId).replace(/[^a-z0-9-]+/gi, '-')
  const safeDocumentName = documentName.replace(/[^a-z0-9-]+/gi, '-')
  link.href = objectUrl
  link.download = `${safeRequestId}-${safeDocumentName}.docx`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
}
