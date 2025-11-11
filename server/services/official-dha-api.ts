import axios, { AxiosInstance, AxiosError, AxiosRequestConfig } from 'axios';
import * as crypto from 'crypto';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import { z } from 'zod';
import { storage } from '../storage.js';
import { AuditAction } from '../../shared/schema/index.js';

/**
 * 🏛️ OFFICIAL DHA API INTEGRATION MODULE
 * Production-grade integration with South African Department of Home Affairs
 * 
 * Features:
 * - Real NPR (National Population Register) integration
 * - Real ABIS (Automated Biometric Identification System) integration
 * - Secure authentication with request signing
 * - Military-grade encryption for sensitive data
 * - Comprehensive audit logging for compliance
 * - Automatic retry logic with exponential backoff
 * - Rate limiting for government API compliance
 */

// ==================== TYPE DEFINITIONS ====================

export interface IdentityVerificationRequest {
  idNumber: string;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
}

export interface IdentityVerificationResponse {
  verified: boolean;
  citizen: boolean;
  success: boolean; // Added required property
  details?: {
    fullName: string;
    idNumber: string;
    dateOfBirth: string;
    gender: string;
    citizenship: string;
    maritalStatus?: string;
    deceased?: boolean;
  };
  verificationScore?: number;
  timestamp: string;
}

export interface BiometricValidationRequest {
  biometricData: {
    type: 'fingerprint' | 'face' | 'iris';
    data: string; // Base64 encoded biometric data
    quality?: number;
  };
  idNumber?: string;
  referenceId?: string;
}

export interface BiometricValidationResponse {
  validated: boolean;
  matchScore: number;
  confidence: number;
  success: boolean; // Added required property
  details?: {
    biometricType: string;
    qualityScore: number;
    matchedIdentity?: string;
    fraudRisk?: number;
  };
  timestamp: string;
}

export interface DocumentTemplateRequest {
  documentType: string;
  version?: string;
  format?: 'pdf' | 'html' | 'json';
}

export interface DocumentTemplateResponse {
  documentType: string;
  template: string | Buffer;
  version: string;
  fields: string[];
  securityFeatures: string[];
}

export interface DocumentRegistrationRequest {
  document: {
    type: string;
    number: string;
    applicantId: string;
    data: Record<string, any>;
    issuedDate: string;
    expiryDate?: string;
  };
  biometrics?: BiometricValidationRequest['biometricData'];
  verificationCode?: string;
}

export interface DocumentRegistrationResponse {
  registered: boolean;
  registrationNumber: string;
  documentNumber: string;
  verificationUrl: string;
  timestamp: string;
}

export interface DocumentNumberGenerationRequest {
  type: string;
  applicantId?: string;
  year?: number;
}

export interface DocumentNumberGenerationResponse {
  documentNumber: string;
  checkDigit: string;
  barcodeData: string;
  qrData: string;
}

// Validation schemas for response data
const identityResponseSchema = z.object({
  verified: z.boolean(),
  citizen: z.boolean(),
  success: z.boolean(), // Added schema for success
  details: z.object({
    fullName: z.string(),
    idNumber: z.string(),
    dateOfBirth: z.string(),
    gender: z.string(),
    citizenship: z.string(),
  }).optional(),
});

const biometricResponseSchema = z.object({
  validated: z.boolean(),
  matchScore: z.number(),
  confidence: z.number(),
  success: z.boolean(), // Added schema for success
});

// ==================== DHA API CLIENT ====================

export class OfficialDHAAPIClient {
  private nprClient: AxiosInstance;
  private abisClient: AxiosInstance;
  private dhaClient: AxiosInstance;
  private rateLimiter: RateLimiterMemory;
  private encryptionKey: string;
  private signingKey: string;
  private retryAttempts: number = 3;
  private retryDelay: number = 1000;

  constructor() {
    // Initialize encryption and signing keys
    this.encryptionKey = process.env.DOCUMENT_ENCRYPTION_KEY || '';
    this.signingKey = process.env.DOCUMENT_SIGNING_KEY || '';

    if (!this.encryptionKey || !this.signingKey) {
      console.warn('[DHA API] Missing encryption or signing keys - running in degraded mode');
    }

    // Initialize rate limiter (10 requests per second for government APIs)
    this.rateLimiter = new RateLimiterMemory({
      points: 10,
      duration: 1,
      blockDuration: 60,
    });

    // Initialize NPR client
    this.nprClient = axios.create({
      baseURL: process.env.DHA_NPR_BASE_URL || 'https://npr.dha.gov.za/api/v1',
      timeout: 30000,
      headers: {
        'X-API-Key': process.env.DHA_NPR_API_KEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DHA-Integration-Client/1.0',
      },
    });

    // Initialize ABIS client
    this.abisClient = axios.create({
      baseURL: process.env.DHA_ABIS_BASE_URL || 'https://abis.dha.gov.za/api/v1',
      timeout: 45000,
      headers: {
        'X-API-Key': process.env.DHA_ABIS_API_KEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DHA-Integration-Client/1.0',
      },
    });

    // Initialize general DHA client
    this.dhaClient = axios.create({
      baseURL: process.env.DHA_BASE_URL || 'https://api.dha.gov.za/v1',
      timeout: 30000,
      headers: {
        'X-API-Key': process.env.DHA_API_KEY || '',
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'DHA-Integration-Client/1.0',
      },
    });

    // Add request interceptors for authentication and signing
    this.setupInterceptors();
  }

  // ==================== AUTHENTICATION & SIGNING ====================

  private setupInterceptors(): void {
    const addSignature = (config: any): any => {
      if (this.signingKey) {
        const timestamp = Date.now().toString();
        const payload = JSON.stringify(config.data || {});
        const signature = this.generateSignature(payload, timestamp);

        config.headers = {
          ...config.headers,
          'X-Timestamp': timestamp,
          'X-Signature': signature,
        };
      }
      return config;
    };

    this.nprClient.interceptors.request.use(addSignature);
    this.abisClient.interceptors.request.use(addSignature);
    this.dhaClient.interceptors.request.use(addSignature);
  }

  private generateSignature(payload: string, timestamp: string): string {
    const message = `${timestamp}:${payload}`;
    return crypto
      .createHmac('sha256', this.signingKey)
      .update(message)
      .digest('hex');
  }

  // ==================== ENCRYPTION UTILITIES ====================

  private encryptData(data: string): string {
    if (!this.encryptionKey) return data;

    const iv = crypto.randomBytes(16);
    const key = Buffer.from(this.encryptionKey, 'hex');
    const cipher = crypto.createCipheriv('aes-256-cbc', key as any, iv as any);

    const encrypted = Buffer.concat([
      cipher.update(data, 'utf8') as any,
      cipher.final()
    ] as any);

    return iv.toString('hex') + ':' + encrypted.toString('hex');
  }

  private decryptData(encryptedData: string): string {
    if (!this.encryptionKey) return encryptedData;

    const parts = encryptedData.split(':');
    const iv = Buffer.from(parts[0], 'hex');
    const encrypted = parts[1];
    const key = Buffer.from(this.encryptionKey, 'hex');

    const decipher = crypto.createDecipheriv('aes-256-cbc', key as any, iv as any);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  // ==================== RATE LIMITING ====================

  private async checkRateLimit(): Promise<void> {
    try {
      await this.rateLimiter.consume('dha-api', 1);
    } catch (error) {
      throw new Error('Rate limit exceeded. Please try again later.');
    }
  }

  // ==================== RETRY LOGIC ====================

  private async withRetry<T>(
    operation: () => Promise<T>,
    context: string
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        await this.checkRateLimit();
        return await operation();
      } catch (error) {
        lastError = error as Error;

        if (axios.isAxiosError(error)) {
          const axiosError = error as AxiosError;

          // Don't retry on client errors (4xx)
          if (axiosError.response?.status && axiosError.response.status >= 400 && axiosError.response.status < 500) {
            throw error;
          }
        }

        if (attempt < this.retryAttempts) {
          const delay = this.retryDelay * Math.pow(2, attempt - 1);
          console.log(`[DHA API] ${context} failed (attempt ${attempt}), retrying in ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error(`${context} failed after ${this.retryAttempts} attempts`);
  }

  // ==================== AUDIT LOGGING ====================

  private async logAuditEvent(
    action: string,
    details: Record<string, any>,
    outcome: 'success' | 'failure',
    userId?: string
  ): Promise<void> {
    try {
      await storage.createAuditLog({
        action: action as AuditAction,
        actor: userId || 'system',
        resource: 'dha_api',
        result: outcome,
        metadata: {
          ...details,
          timestamp: new Date().toISOString(),
          environment: process.env.NODE_ENV,
        },
        ipAddress: details.ipAddress || 'internal',
        userAgent: 'DHA-API-Client',
      });
    } catch (error) {
      console.error('[DHA API] Failed to log audit event:', error);
    }
  }

  // ==================== PUBLIC API METHODS ====================

  /**
   * Verify citizen identity through NPR (National Population Register)
   */
  public async verifyIdentity(
    idNumber: string,
    additionalData?: Partial<IdentityVerificationRequest>
  ): Promise<IdentityVerificationResponse> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const encryptedId = this.encryptData(idNumber);

        const result = await this.nprClient.post('/identity/verify', {
          idNumber: encryptedId,
          ...additionalData,
        });

        return result.data;
      }, 'Identity verification');

      // Validate response
      const validated = identityResponseSchema.parse(response);

      // Audit log
      await this.logAuditEvent(
        'DHA_NPR_VERIFY',
        {
          idNumber: idNumber.substring(0, 6) + '****',
          verified: validated.verified,
          duration: Date.now() - startTime,
        },
        'success'
      );

      // Construct the response object to match the interface
      return {
        timestamp: new Date().toISOString(),
        details: validated.details,
        citizen: validated.citizen,
        verified: validated.verified,
        success: true, // Set success to true
      } as IdentityVerificationResponse;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_NPR_VERIFY',
        {
          idNumber: idNumber.substring(0, 6) + '****',
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw new Error(`Identity verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate biometrics through ABIS (Automated Biometric Identification System)
   */
  public async validateBiometrics(
    biometricData: BiometricValidationRequest['biometricData'],
    referenceId?: string
  ): Promise<BiometricValidationResponse> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        // Encrypt biometric data
        const encryptedBiometrics = this.encryptData(biometricData.data);

        const result = await this.abisClient.post('/biometric/validate', {
          biometricData: {
            ...biometricData,
            data: encryptedBiometrics,
          },
          referenceId,
        });

        return result.data;
      }, 'Biometric validation');

      // Validate response
      const validated = biometricResponseSchema.parse(response);

      // Audit log
      await this.logAuditEvent(
        'DHA_ABIS_VALIDATE',
        {
          biometricType: biometricData.type,
          validated: validated.validated,
          matchScore: validated.matchScore,
          duration: Date.now() - startTime,
        },
        'success'
      );

      // Construct the response object to match the interface
      return {
        timestamp: new Date().toISOString(),
        confidence: validated.confidence,
        matchScore: validated.matchScore,
        validated: validated.validated,
        success: true, // Set success to true
      } as BiometricValidationResponse;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_ABIS_VALIDATE',
        {
          biometricType: biometricData.type,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw new Error(`Biometric validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Get official document templates from DHA
   */
  public async getDocumentTemplate(
    documentType: string,
    options?: Partial<DocumentTemplateRequest>
  ): Promise<DocumentTemplateResponse> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.get(`/templates/${documentType}`, {
          params: {
            version: options?.version || 'latest',
            format: options?.format || 'pdf',
          },
        });

        return result.data;
      }, 'Get document template');

      // Audit log
      await this.logAuditEvent(
        'DHA_GET_TEMPLATE',
        {
          documentType,
          version: response.version,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_GET_TEMPLATE',
        {
          documentType,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw new Error(`Failed to get document template: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Submit documents for official registration
   */
  public async registerDocument(
    document: DocumentRegistrationRequest
  ): Promise<DocumentRegistrationResponse> {
    const startTime = Date.now();

    try {
      // Encrypt sensitive document data
      const encryptedDocument = {
        ...document,
        document: {
          ...document.document,
          data: this.encryptData(JSON.stringify(document.document.data)),
        },
      };

      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.post('/documents/register', encryptedDocument);
        return result.data;
      }, 'Document registration');

      // Audit log
      await this.logAuditEvent(
        'DHA_REGISTER_DOCUMENT',
        {
          documentType: document.document.type,
          documentNumber: response.documentNumber,
          registered: response.registered,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_REGISTER_DOCUMENT',
        {
          documentType: document.document.type,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw new Error(`Document registration failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Generate official document numbers
   */
  public async generateDocumentNumber(
    type: string,
    options?: Partial<DocumentNumberGenerationRequest>
  ): Promise<DocumentNumberGenerationResponse> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.post('/documents/generate-number', {
          type,
          applicantId: options?.applicantId,
          year: options?.year || new Date().getFullYear(),
        });

        return result.data;
      }, 'Generate document number');

      // Audit log
      await this.logAuditEvent(
        'DHA_GENERATE_NUMBER',
        {
          documentType: type,
          documentNumber: response.documentNumber,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_GENERATE_NUMBER',
        {
          documentType: type,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw new Error(`Failed to generate document number: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // ==================== ADDITIONAL UTILITY METHODS ====================

  /**
   * Validate document against DHA records
   */
  public async validateDocument(
    documentNumber: string,
    documentType: string
  ): Promise<{ valid: boolean; details?: any }> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.post('/documents/validate', {
          documentNumber: this.encryptData(documentNumber),
          documentType,
        });

        return result.data;
      }, 'Document validation');

      await this.logAuditEvent(
        'DHA_VALIDATE_DOCUMENT',
        {
          documentType,
          valid: response.valid,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_VALIDATE_DOCUMENT',
        {
          documentType,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw error;
    }
  }

  /**
   * Check criminal record through integrated SAPS API
   */
  public async checkCriminalRecord(
    idNumber: string
  ): Promise<{ clearance: boolean; details?: any }> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.post('/saps/criminal-check', {
          idNumber: this.encryptData(idNumber),
        });

        return result.data;
      }, 'Criminal record check');

      await this.logAuditEvent(
        'DHA_SAPS_CHECK',
        {
          clearance: response.clearance,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_SAPS_CHECK',
        {
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw error;
    }
  }

  /**
   * Verify international travel document
   */
  public async verifyInternationalDocument(
    passportNumber: string,
    countryCode: string
  ): Promise<{ verified: boolean; details?: any }> {
    const startTime = Date.now();

    try {
      const response = await this.withRetry(async () => {
        const result = await this.dhaClient.post('/icao/verify', {
          passportNumber: this.encryptData(passportNumber),
          countryCode,
        });

        return result.data;
      }, 'International document verification');

      await this.logAuditEvent(
        'DHA_ICAO_VERIFY',
        {
          countryCode,
          verified: response.verified,
          duration: Date.now() - startTime,
        },
        'success'
      );

      return response;
    } catch (error) {
      await this.logAuditEvent(
        'DHA_ICAO_VERIFY',
        {
          countryCode,
          error: error instanceof Error ? error.message : 'Unknown error',
          duration: Date.now() - startTime,
        },
        'failure'
      );

      throw error;
    }
  }

  /**
   * Get API health status
   */
  public async getHealthStatus(): Promise<{
    npr: boolean;
    abis: boolean;
    dha: boolean;
    saps: boolean;
    icao: boolean;
  }> {
    const status = {
      npr: false,
      abis: false,
      dha: false,
      saps: false,
      icao: false,
    };

    try {
      const [nprHealth, abisHealth, dhaHealth] = await Promise.allSettled([
        this.nprClient.get('/health'),
        this.abisClient.get('/health'),
        this.dhaClient.get('/health'),
      ]);

      status.npr = nprHealth.status === 'fulfilled' && nprHealth.value.status === 200;
      status.abis = abisHealth.status === 'fulfilled' && abisHealth.value.status === 200;
      status.dha = dhaHealth.status === 'fulfilled' && dhaHealth.value.status === 200;

      // Check SAPS and ICAO through main DHA API
      const integrationsHealth = await this.dhaClient.get('/integrations/health');
      if (integrationsHealth.data) {
        status.saps = integrationsHealth.data.saps || false;
        status.icao = integrationsHealth.data.icao || false;
      }
    } catch (error) {
      console.error('[DHA API] Health check failed:', error);
    }

    return status;
  }
}

// ==================== DOCUMENT TYPE CONSTANTS ====================

export const DHA_DOCUMENT_TYPES = {
  // Identity Documents
  SMART_ID: 'smart_id_card',
  ID_BOOK: 'identity_document_book',
  TEMP_ID: 'temporary_id_certificate',

  // Travel Documents
  PASSPORT: 'south_african_passport',
  EMERGENCY_TRAVEL: 'emergency_travel_certificate',
  REFUGEE_TRAVEL: 'refugee_travel_document',

  // Civil Documents
  BIRTH_CERT: 'birth_certificate',
  DEATH_CERT: 'death_certificate',
  MARRIAGE_CERT: 'marriage_certificate',
  DIVORCE_CERT: 'divorce_certificate',

  // Immigration Documents
  PRP: 'permanent_residence_permit',
  TRV: 'temporary_residence_visa',
  GENERAL_WORK: 'general_work_visa',
  CRITICAL_SKILLS: 'critical_skills_work_visa',
  BUSINESS_VISA: 'business_visa',
  STUDY_VISA: 'study_visa_permit',
  VISITOR_VISA: 'visitor_visa',
  RELATIVES_VISA: 'relatives_visa',
  MEDICAL_VISA: 'medical_treatment_visa',
  RETIRED_VISA: 'retired_person_visa',

  // Special Documents
  REFUGEE_STATUS: 'refugee_status_permit',
  ASYLUM_SEEKER: 'asylum_seeker_permit',
  EXEMPTION_CERT: 'certificate_of_exemption',
  CITIZENSHIP_CERT: 'certificate_of_citizenship',
} as const;

// ==================== SINGLETON EXPORT ====================

let apiClient: OfficialDHAAPIClient | null = null;

export function getOfficialDHAAPI(): OfficialDHAAPIClient {
  if (!apiClient) {
    apiClient = new OfficialDHAAPIClient();
  }
  return apiClient;
}

// Default export
export const officialDHAAPI = {
  getClient: getOfficialDHAAPI,
  documentTypes: DHA_DOCUMENT_TYPES,
};