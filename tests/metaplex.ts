import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { deserializeMetadata } from "@metaplex-foundation/mpl-token-metadata";
import { publicKey } from "@metaplex-foundation/umi";
import { TOKEN_METADATA_PROGRAM_ID } from "../const";

export function deserializeMetaplexMetadata(
  address: PublicKey,
  account: AccountInfo<Uint8Array | Buffer>
) {
  const { executable, rentEpoch, owner, lamports, data } = account;

  const metadata = deserializeMetadata({
    executable,
    rentEpoch: BigInt(rentEpoch),
    owner: publicKey(owner),
    lamports: {
      decimals: 9,
      basisPoints: BigInt(lamports),
      identifier: "SOL",
    },
    data,
    publicKey: publicKey(address),
  });

  return metadata;
}

export function getNftMetadataAddress(mint: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

export function getCollectionAddress(
  metadataAddress: PublicKey,
  metadataInfo: AccountInfo<Uint8Array | Buffer> | null
) {
  if (metadataInfo === null) {
    throw new Error("Metadata info is null");
  }

  const metadata = deserializeMetaplexMetadata(metadataAddress, metadataInfo);

  const nftCollection =
    metadata.collection.__option === "Some" && metadata.collection.value
      ? metadata.collection.value
      : (() => {
          throw new Error("NFT collection is missing or invalid");
        })();

  return new PublicKey(nftCollection.key);
}
