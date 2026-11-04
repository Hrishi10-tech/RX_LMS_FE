export enum UserRole {
  SUPER_ADMIN = 'SUPER_ADMIN',
  ADMIN = 'ADMIN',
  MANAGER = 'MANAGER',
  USER = 'USER',
  LAB = 'LAB',
  PROCUREMENT = 'PROCUREMENT',
  INVENTORY = 'INVENTORY',
  FINANCE = 'FINANCE',
  // Read-only finance assistant — sees Payments & Spend + Fixed Assets
  // but cannot mark indents paid or modify asset records.
  ASSOCIATE_FINANCE = 'ASSOCIATE_FINANCE',
}

export enum RequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  IN_USE = 'IN_USE',
  YET_TO_ISSUE = 'YET_TO_ISSUE',
  OVERDUE = 'OVERDUE',
  RETURN_REQUESTED = 'RETURN_REQUESTED',
  RETURNED = 'RETURNED',
  REJECTED = 'REJECTED',
  DISPOSED = 'DISPOSED',
  EMBEDDED = 'EMBEDDED',
  CONSUMED = 'CONSUMED',
}

export enum IndentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  QUOTATION_IN_PROGRESS = 'QUOTATION_IN_PROGRESS',
  READY_FOR_PAYMENT = 'READY_FOR_PAYMENT',
  AWAITING_PAYMENT = 'AWAITING_PAYMENT',
  PAYMENT_DONE = 'PAYMENT_DONE',
  ORDERED = 'ORDERED',
  IN_TRANSIT = 'IN_TRANSIT',
  PARTIALLY_RECEIVED = 'PARTIALLY_RECEIVED',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

export enum ComponentCategory {
  ELECTRONIC_PASSIVE = 'ELECTRONIC_PASSIVE',
  ELECTRONIC_ACTIVE = 'ELECTRONIC_ACTIVE',
  MECHANICAL_TOOLS = 'MECHANICAL_TOOLS',
  ELECTRONICS_GENERAL_ACCESSORIES = 'ELECTRONICS_GENERAL_ACCESSORIES',
  ELECTRONICS_TOOLS = 'ELECTRONICS_TOOLS',
  MECHANICAL_3D_PRINTING = 'MECHANICAL_3D_PRINTING',
  PACKING_MATERIALS = 'PACKING_MATERIALS',
  SAFETY_WEARABLE = 'SAFETY_WEARABLE',
  STATIONARY_OFFICE = 'STATIONARY_OFFICE',
  CLEANING_ITEMS = 'CLEANING_ITEMS',
  PCB_STENCILS = 'PCB_STENCILS',
}

export enum Nature {
  TEMPORARY = 'TEMPORARY',
  PERMANENT = 'PERMANENT',
}

export enum DurationUnit {
  MINUTES = 'MINUTES',
  HOURS = 'HOURS',
  DAYS = 'DAYS',
  WEEKS = 'WEEKS',
  MONTHS = 'MONTHS',
}

export enum NotificationType {
  OVERDUE = 'OVERDUE',
  DUE_SOON = 'DUE_SOON',
  APPROVAL = 'APPROVAL',
  INFO = 'INFO',
  WARNING = 'WARNING',
  REMINDER = 'REMINDER',
}

/** How a department's indents must be signed off. */
export type IndentApprovalMode = 'MANAGER_REQUIRED' | 'MANAGER_OPTIONAL';

export interface Department {
  id: string;
  name: string;
  parentId: string | null;
  /**
   * Manager AND admin, or either one. Optional on the type because older
   * cached payloads (and the odd nested `department: { id, name }` projection)
   * do not carry it — read it with a MANAGER_OPTIONAL fallback, which is the
   * column default.
   */
  indentApprovalMode?: IndentApprovalMode;
  /** 'FINANCE' | 'PROCUREMENT' | 'INVENTORY' on the departments that are also roles. */
  roleHome?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminDepartment {
  userId: string;
  departmentId: string;
  department?: Department;
}

export interface ManagerUser {
  managerId: string;
  userId: string;
  manager?: User;
  user?: User;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  departmentId: string | null;
  department?: Department;
  adminDepartments?: AdminDepartment[];
  managers?: ManagerUser[];
  managedUsers?: ManagerUser[];
  isActive?: boolean;
  deactivatedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryItem {
  id: string;
  name: string;
  category: ComponentCategory;
  departmentId: string;
  department?: Department;
  stock: number;
  unit: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface IndentItem {
  id: string;
  indentId: string;
  name: string;
  qty: number;
  unit: string;
  unitAmount: number;
  currency: string;
  url: string;
  purpose: string;
  total: number;
  createdAt: string;
  updatedAt: string;
}

export interface Indent {
  id: string;
  serialNo: string;
  projectId: string;
  nature: Nature;
  durationValue: number;
  durationUnit: DurationUnit;
  emergency: boolean;
  grandTotal: number;
  currency: string;
  status: IndentStatus;
  departmentId: string;
  department?: Department;
  createdById: string;
  createdBy?: User;
  approvedById: string | null;
  approvedBy?: User | null;
  approvedAt: string | null;
  items?: IndentItem[];
  createdAt: string;
  updatedAt: string;
}

export interface ComponentRequest {
  id: string;
  serialNo: string;
  inventoryItemId: string;
  inventoryItem?: InventoryItem;
  qtyRequested: number;
  projectId: string;
  nature: Nature;
  durationValue: number;
  durationUnit: DurationUnit;
  status: RequestStatus;
  departmentId: string;
  department?: Department;
  createdById: string;
  createdBy?: User;
  approvedById: string | null;
  approvedBy?: User | null;
  approvedAt: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  returnedAt: string | null;
  disposition?: string | null;
  dispositionDate?: string | null;
  dispositionNotes?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  isRead: boolean;
  relatedEntityId: string | null;
  relatedEntityType: string | null;
  createdAt: string;
  updatedAt: string;
}
