import { serviceConfig, initializeDocumentSecurity, initializeGovernmentServices } from '../../config/service-integration.js'
import * as forge from 'node-forge'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import QRCode from 'qrcode'
import sharp from 'sharp'
import crypto from 'crypto'

export class DocumentService {
  private security = initializeDocumentSecurity()
  private govServices = initializeGovernmentServices()

  // Generate secure document with all required features
  async generateSecureDocument(data: any, documentType: string) {
    // Validate with DHA NPR
    const nprValidation = await this.govServices.dha.get(`/verify/${data.idNumber}`)
    if (!nprValidation.data.verified) {
      throw new Error('Identity verification failed')
    }

    // Create PDF document
    const pdfDoc = await PDFDocument.create()
    const page = pdfDoc.addPage()
    const font = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

    // Add security features
    const securityFeatures = await this.addSecurityFeatures(data)

    // Add biometric data if available
    if (data.biometrics) {
      await this.addBiometricData(pdfDoc, data.biometrics)
    }

    // Generate QR code with verification data
    const qrCode = await this.generateVerificationQR(data)

    // Add document content
    page.drawText('REPUBLIC OF SOUTH AFRICA', {
      x: 50,
      y: 750,
      size: 16,
      font
    })

    // Add document specific content
    await this.addDocumentContent(page, data, documentType)

    // Add security watermark
    await this.addSecurityWatermark(page)

    // Add digital signature
    const signature = this.security.sign(JSON.stringify(data))

    // Final security wrapper
    const finalDoc = await this.wrapWithSecurity({
      pdf: await pdfDoc.save(),
      signature,
      qrCode,
      securityFeatures
    })

    return finalDoc
  }

  private async addSecurityFeatures(data: any) {
    return {
      hologram: await this.generateHologram(),
      microprint: await this.generateMicroprint(data),
      uvFeatures: await this.generateUVFeatures(),
      securityThread: await this.generateSecurityThread()
    }
  }

  private async generateHologram() {
    // Generate dynamic hologram pattern
    const pattern = crypto.randomBytes(32)
    return forge.util.encode64(pattern)
  }

  private async generateMicroprint(data: any) {
    // Generate microprint with document details
    const text = `RSA DHA ${data.documentNumber} ${Date.now()}`
    return await sharp({
      text: {
        text,
        font: 'sans-serif',
        fontSize: 1
      },
      width: 100,
      height: 20
    }).toBuffer()
  }

  private async generateUVFeatures() {
    // Generate UV-reactive security features
    return crypto.randomBytes(64)
  }

  private async generateSecurityThread() {
    // Generate metallic security thread pattern
    return crypto.randomBytes(48)
  }

  private async addSecurityWatermark(page: any) {
    // Add security watermark to the page
    const watermarkText = `SECURED ${Date.now()}`
    page.drawText(watermarkText, {
      x: 50,
      y: 50,
      size: 12,
      opacity: 0.1,
      rotate: Math.PI / 4
    })
  }

  private async generateVerificationQR(data: any) {
    const verificationData = {
      docType: data.documentType,
      id: data.documentNumber,
      hash: crypto.createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex')
    }

    return await QRCode.toBuffer(JSON.stringify(verificationData))
  }

  private async addBiometricData(doc: PDFDocument, biometrics: any) {
    // Add encrypted biometric data
    const encryptedBiometrics = crypto.privateEncrypt(
      serviceConfig.documents.pki.privateKey,
      Buffer.from(JSON.stringify(biometrics))
    )

    const attachment = await doc.attach(
      encryptedBiometrics,
      'biometrics.dat',
      {
        mimeType: 'application/octet-stream',
        description: 'Encrypted Biometric Data'
      }
    )
  }

  private async addDocumentContent(page: any, data: any, documentType: string) {
    // Add document specific content based on type
    switch(documentType) {
      case 'passport':
        await this.addPassportContent(page, data)
        break
      case 'id_card':
        await this.addIDCardContent(page, data)
        break
      case 'birth_certificate':
        await this.addBirthCertContent(page, data)
        break
      // Add other document types
    }
  }

  private async wrapWithSecurity(doc: any) {
    // Add final security wrapper
    const wrapped = {
      document: doc.pdf,
      signature: doc.signature,
      qrCode: doc.qrCode,
      securityFeatures: doc.securityFeatures,
      metadata: {
        timestamp: Date.now(),
        issuer: 'DHA Digital Services',
        verificationEndpoint: '/api/verify'
      }
    }

    // Encrypt the whole package
    const encryptionKey = crypto.randomBytes(32)
    const iv = crypto.randomBytes(16)

    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      encryptionKey,
      iv
    )

    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(wrapped)),
      cipher.final()
    ])

    return {
      package: encrypted,
      key: crypto.publicEncrypt(
        serviceConfig.documents.pki.publicKey,
        encryptionKey
      ),
      iv
    }
  }

  // Verification method
  async verifyDocument(encryptedDoc: any) {
    try {
      // Decrypt and verify
      const decryptionKey = crypto.privateDecrypt(
        serviceConfig.documents.pki.privateKey,
        encryptedDoc.key
      )

      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        decryptionKey,
        encryptedDoc.iv
      )

      const decrypted = Buffer.concat([
        decipher.update(encryptedDoc.package),
        decipher.final()
      ]).toString()

      const parsedDecrypted = JSON.parse(decrypted)

      // Verify signature
      const isValid = this.security.verify(
        JSON.stringify(parsedDecrypted.document),
        parsedDecrypted.signature
      )

      if (!isValid) {
        throw new Error('Invalid document signature')
      }

      return {
        verified: true,
        document: parsedDecrypted.document,
        metadata: parsedDecrypted.metadata
      }

    } catch (error) {
      console.error('Document verification failed:', error)
      return {
        verified: false,
        error: 'Document verification failed'
      }
    }
  }
}