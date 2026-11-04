/**
 * Where a notification takes you when clicked — the card on the Notifications
 * page, a desktop alert, and the in-page banner all use this one mapping, so a
 * click lands on the same record wherever it starts.
 *
 * Where an entity lives depends on who is looking: an indent opens a
 * requester's tracker, an admin's Approvals page, Procurement's queue, and so on.
 */
// The "personal tracker" page where a requester sees their own indents/requests
// (StandardIPRequestsPage, which handles ?openIndent / ?openRequest).
// Every role reaches it at /<slug>/ip-requests EXCEPT LAB, whose tracker is
// mounted at /lab/indents. FINANCE/ASSOCIATE_FINANCE now have their own
// /<slug>/ip-requests route (added with I/P-page access) — they must NOT be
// sent to /<slug>/indents, which for them is the Payments & Spend page and
// ignores the open* params (the entity modal would silently never open).
const personalTrackerBase = (role: string, roleSlug: string): string =>
    role === 'LAB' ? `/${roleSlug}/indents` : `/${roleSlug}/ip-requests`;

export const buildClickTargetUrl = (notif: any, role: string, roleSlug: string): string | null => {


    if (!notif?.relatedEntityId || !notif?.relatedEntityType) return null;
    const id = notif.relatedEntityId;
    switch (notif.relatedEntityType) {
        case 'INDENT_RECEIVED_CLAIM':
            // The claim modal lives on StandardDashboardPage, mounted at /user,
            // /manager, and /lab/inventory — but NOT /lab (that's LabDashboardPage,
            // which ignores the param). The old `/${roleSlug}` sent LAB to that
            // dead no-op page. Route LAB to /lab/inventory; roles without the
            // claim modal (ADMIN/PROCUREMENT who can also raise indents) land on
            // their indent tracker so the card still shows the received indent.
            if (role === 'LAB') return `/lab/inventory?claimFromIndent=${id}`;
            if (role === 'USER' || role === 'MANAGER') return `/${roleSlug}?claimFromIndent=${id}`;
            return `${personalTrackerBase(role, roleSlug)}?openIndent=${id}`;
        case 'INDENT_RECEIVED_INVENTORY':
            // Inventory clerk side of the same arrival event — open the
            // "Receive from Procurement" modal with this indent pre-selected
            // so they go straight to verify + shelf without re-navigating.
            return `/inventory?openReceive=${id}`;
        case 'INDENT': {
            // MANAGER never approves indents (tech = admin, ceo = super-admin),
            // so their indent notifications are always team-oversight ("a direct
            // report raised IND-xxx"). Those rows live on Team Approvals, not the
            // personal Approvals page (which is createdByMe-scope and shows an
            // empty "No pending indent approvals"). Mirror the COMPONENT_REQUEST
            // manager case → land them where the indent is actually visible.
            if (role === 'MANAGER') return `/manager/team-approvals`;
            // Finance is Associate Finance's manager — an approval ask is theirs
            // to sign on Team Approvals; payment notices stay on Payments.
            if (role === 'FINANCE' && notif.type === 'APPROVAL') return `/finance/team-approvals`;
            if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
                return `/${roleSlug}/approvals?openIndent=${id}`;
            }
            // Procurement's queue and Finance's Payments page both open the
            // indent from ?openIndent (they did not read it before, so the
            // click just landed on the list).
            if (role === 'PROCUREMENT') return `/procurement/indents?openIndent=${id}`;
            if (role === 'FINANCE' || role === 'ASSOCIATE_FINANCE') return `/${roleSlug}/indents?openIndent=${id}`;
            // INVENTORY's /inventory/requests only understands openRequest; an
            // indent notice for them is about their own indent (shelving has
            // its own INDENT_RECEIVED_INVENTORY link), so use their tracker.
            // USER/LAB/INVENTORY → their personal indent tracker.
            return `${personalTrackerBase(role, roleSlug)}?openIndent=${id}`;
        }
        case 'COMPONENT_REQUEST': {
            // MANAGER reviews their team's ad-hoc requests on Team Approvals
            // (inline approve/reject lives there). The personal Approvals page
            // is personal-scope only (createdByMe) and never lists a direct
            // report's request — routing a manager there drops them on an
            // empty "No pending ad-hoc request approvals" section.
            if (role === 'MANAGER') return `/manager/team-approvals`;
            if (role === 'FINANCE' && notif.type === 'APPROVAL') return `/finance/team-approvals`;
            if (role === 'ADMIN' || role === 'SUPER_ADMIN') {
                return `/${roleSlug}/approvals?openRequest=${id}`;
            }
            if (role === 'INVENTORY') return `/inventory/requests?openRequest=${id}`;
            // Requester (USER/LAB) → their tracker with the row highlighted.
            return `${personalTrackerBase(role, roleSlug)}?openRequest=${id}`;
        }
        case 'INVENTORY_ITEM_AVAILABLE':
            // Request Component modal — same StandardDashboardPage-only param as
            // the claim case, so route LAB to /lab/inventory (not the ignoring
            // /lab index). Roles without that modal get an inert card rather
            // than a dead navigation to a page that drops the param.
            if (role === 'LAB') return `/lab/inventory?requestItem=${id}`;
            if (role === 'USER' || role === 'MANAGER') return `/${roleSlug}?requestItem=${id}`;
            return null;
        case 'BOM_LIST': {
            // Approver's "review this BOM" notification → open the approval slip.
            // MANAGER reviews their direct reports' BOMs on Team Approvals (team
            // work); ADMIN reviews on their personal Approvals console.
            if (notif.type === 'APPROVAL') {
                if (role === 'MANAGER') return `/manager/team-approvals?openBom=${id}`;
                if (role === 'ADMIN') return `/${roleSlug}/approvals?openBom=${id}`;
            }
            // Inventory's post-routing copy → their BOM batches view.
            if (role === 'INVENTORY') return `/inventory/bom-batches`;
            // SUPER_ADMIN has no Lists route, but their Approvals console opens
            // any BOM slip by id (the modal fetches it directly), so send the
            // CEO there for oversight instead of leaving the card inert.
            if (role === 'SUPER_ADMIN') return `/${roleSlug}/approvals?openBom=${id}`;
            // Creator / managers / admins / user / lab outcome copy → open in Lists.
            return `/${roleSlug}/lists?openList=${id}`;
        }
        case 'SUBSCRIPTION':
            // Expiry reminders go to FINANCE only; land them on the list.
            return role === 'FINANCE' ? `/finance/subscriptions` : null;
        case 'REQUEST':
            // "Please return X" → borrower's tracker; INVENTORY clerk → returns desk.
            if (role === 'INVENTORY') return `/inventory/returns`;
            if (role === 'USER' || role === 'LAB' || role === 'MANAGER')
                return personalTrackerBase(role, roleSlug);
            return null;
        case 'FIXED_ASSET':
            // Custodian INFO copy → fixed-assets page, for roles that have one.
            if (role === 'INVENTORY' || role === 'FINANCE' || role === 'ASSOCIATE_FINANCE')
                return `/${roleSlug}/fixed-assets`;
            return null;
        case 'FIXED_ASSET_APPROVAL': {
            // Reviewer "pending review" ping (FINANCE-only) → open approvals modal.
            if (role === 'FINANCE' && notif.type === 'INFO')
                return `/finance/fixed-assets?openApprovals=1`;
            // Submitter outcome copy (approved/rejected) → their fixed-assets page if any.
            if (role === 'INVENTORY' || role === 'FINANCE' || role === 'ASSOCIATE_FINANCE')
                return `/${roleSlug}/fixed-assets`;
            return null;
        }
        case 'FEEDBACK':
            // New feedback → the CEO's inbox (only the Super Admin reads it).
            return role === 'SUPER_ADMIN' ? `/super-admin/feedback` : null;
        case 'CONVERSATION':
            // A chat message while you were away — open Connect.
            return `/${roleSlug}/messages`;
        case 'TAKEOVER_INDENT':
        case 'TAKEOVER_REQUEST':
        case 'TAKEOVER_BOM':
        // Procurement / Inventory's notice about a person's work with no owner.
        case 'TAKEOVER_ESCALATION':
            // The offer is taken on the Notifications page itself (top box).
            return `/${roleSlug}/notifications`;
        case 'USER':
            // Account notices (a password set by someone else, a deactivation)
            // → the users list of whoever can act on it.
            if (role === 'SUPER_ADMIN') return `/super-admin/users`;
            if (role === 'ADMIN') return `/admin/users`;
            return null;
        // BACKORDER cards stay on this page — claim/decline buttons live here.
        default:
            return null;
    }
};
