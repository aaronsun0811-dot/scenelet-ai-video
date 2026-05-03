import { AssetCard } from "./AssetCard";
import type { Asset } from "@/types/asset";

interface Props {
  assets: Asset[];
  highlightedAssetId?: string | null;
  onEdit: (a: Asset) => void;
  onDelete: (a: Asset) => void;
}

export function AssetGrid({ assets, highlightedAssetId, onEdit, onDelete }: Props) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
      {assets.map((a) => (
        <AssetCard
          key={a.id}
          asset={a}
          highlighted={a.id === highlightedAssetId}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  );
}
