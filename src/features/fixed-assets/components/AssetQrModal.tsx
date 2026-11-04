import { useState, useEffect } from 'react';
import { Modal } from '@/components/ui';
import { Download } from 'lucide-react';
import { client } from '@/api';
import { useToast } from '@/context/ToastContext';
import { extractErrorMessage } from '@/lib';

interface AssetQrModalProps {
    asset: any;
    onClose: () => void;
}

// Tiny QR modal. The PNG is served by GET /fixed-assets/:id/qr.png, which sits
// behind JwtAuthGuard. The app keeps its JWT in sessionStorage (NOT a cookie),
// so a plain <img src> or a fetch(credentials:'include') hits the endpoint
// unauthenticated and 401s — the QR never renders. We fetch the PNG through the
// authenticated axios client (which attaches Authorization: Bearer + handles
// token refresh), blob it, and point both the <img> and the download button at
// the resulting object URL. Same blob pattern as ViewReceiptLink/ExportPanel.
export const AssetQrModal = ({ asset, onClose }: AssetQrModalProps) => {
    const { addToast } = useToast();
    const [objectUrl, setObjectUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);

    useEffect(() => {
        if (!asset?.id) return;
        let cancelled = false;
        let url: string | null = null;
        setLoading(true);
        client
            .get(`/fixed-assets/${asset.id}/qr.png`, { responseType: 'blob' })
            .then((res) => {
                if (cancelled) return;
                url = URL.createObjectURL(res.data as Blob);
                setObjectUrl(url);
            })
            .catch((e: any) => {
                if (!cancelled) addToast(extractErrorMessage(e, 'Could not load QR code'), 'error');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
            setObjectUrl(null);
        };
    }, [asset?.id, addToast]);

    if (!asset) return null;

    const downloadPng = () => {
        if (!objectUrl) return;
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `${asset.assetTag || 'asset'}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    };

    return (
        <Modal isOpen={!!asset} onClose={onClose} title={`QR Code — ${asset.assetTag}`}>
            <div className="space-y-3 flex flex-col items-center">
                <p className="text-sm text-muted text-center">
                    Scan this with a phone to open the asset's detail page directly.
                </p>
                <div className="border border-line rounded-lg p-3 bg-card w-[280px] h-[280px] flex items-center justify-center">
                    {objectUrl ? (
                        <img src={objectUrl} alt={`QR for ${asset.assetTag}`} className="w-64 h-64 object-contain" />
                    ) : (
                        <span className="text-xs text-faint">{loading ? 'Loading QR…' : 'QR unavailable'}</span>
                    )}
                </div>
                <p className="text-xs text-faint font-mono">{asset.assetTag} · {asset.name}</p>
                <button
                    onClick={downloadPng}
                    disabled={!objectUrl}
                    className="flex items-center gap-2 text-sm font-bold bg-brand text-white px-4 py-2 rounded-full hover:bg-brand-dark transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    <Download size={14} /> Download PNG
                </button>
            </div>
        </Modal>
    );
};
