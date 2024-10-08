import { startAnchor, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import {
  AccountInfo,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { Program, IdlAccounts, BN } from "@coral-xyz/anchor";
import {
  airdropSol,
  createTokenAccountAndCredit,
  createToken,
  getTokenBalance,
  setSplToAccount,
  d,
  assertDeepEqual,
  closeTo,
  simulateTimePassage,
  calculateClaimableReward,
  getSeedAccounts,
  setupAddresses,
  eq,
  expectErrorWitLog,
} from "./utils";
import chai from "chai";
import chaiAsPromised from "chai-as-promised";
import { ViridisStaking } from "../target/types/viridis_staking";
import IDL from "../target/idl/viridis_staking.json";
import {
  DECIMALS,
  mintKeypair,
  DEFAULT_NFT_APY,
  ONE_DAY_SECONDS,
  ONE_YEAR_SECONDS,
  userA,
  userB,
} from "./const";
import { StakeEntry } from "./types";
import {
  claimRpc,
  destakeRpc,
  initializeStakeInfoRpc,
  lockNftRpc,
  restakeRpc,
  stakeRpc,
  unlockNftRpc,
} from "./rpc";
import { TEST_NFT_ADDRESS_WRONG_COLLECTION } from "../const";

chai.use(chaiAsPromised);
const { expect } = chai;

describe("staking program in the solana-bankrun simulation", () => {
  type ProgramAccounts = IdlAccounts<ViridisStaking>;

  type Config = ProgramAccounts["config"];
  type StakeInfo = ProgramAccounts["stakeInfo"];

  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<ViridisStaking>;
  let addresses: Awaited<ReturnType<typeof setupAddresses>>;
  let seedAccounts: {
    address: PublicKey;
    info: AccountInfo<Buffer>;
  }[];

  const setupEnvironment = async (
    context: ProgramTestContext,
    program: Program<ViridisStaking>
  ) => {
    await airdropSol(context, userA.publicKey, 1);
    await airdropSol(context, userB.publicKey, 1);
    await createToken(context.banksClient, userA, DECIMALS, mintKeypair);
    await program.methods
      .initialize()
      .accounts({
        signer: userA.publicKey,
        mint: mintKeypair.publicKey,
        nftCollection: addresses.nftCollection,
      })
      .signers([userA])
      .rpc();
  };

  async function fetchStakeInfo(stakeInfoAddress: PublicKey) {
    return program.account.stakeInfo.fetch(stakeInfoAddress);
  }

  async function fetchStakes(stakeInfoAddress: PublicKey) {
    const stakeInfo = await fetchStakeInfo(stakeInfoAddress);
    return stakeInfo.stakes;
  }

  async function fetchNftInfo() {
    return program.account.nftInfo.fetch(addresses.nftInfo);
  }

  async function fetchConfig() {
    return await program.account.config.fetch(addresses.config);
  }

  const getStakeTokenInstruction = async (amountDecimals: bigint) => {
    return program.methods
      .stake(new BN(amountDecimals))
      .accounts({
        signer: userA.publicKey,
        mint: mintKeypair.publicKey,
      })
      .instruction();
  };

  const getDestakeTokenInstruction = async (stakeIndex: number) => {
    return program.methods
      .destake(new BN(stakeIndex))
      .accounts({
        signer: userA.publicKey,
        mint: mintKeypair.publicKey,
      })
      .instruction();
  };

  const getInitializeStakeInfoInstruction = async () => {
    return await program.methods
      .initializeStakeInfo()
      .accounts({
        signer: userA.publicKey,
        stakeInfo: addresses.stakeInfo,
      })
      .instruction();
  };

  const getLockNftInstruction = async (
    stakeIndex: number,
    lockPeriod: number
  ) => {
    return await program.methods
      .lockNft(new BN(stakeIndex), new BN(lockPeriod))
      .accounts({
        signer: userA.publicKey,
        mint: addresses.nft,
      })
      .instruction();
  };

  async function getBalance(address: PublicKey) {
    return getTokenBalance(context, address);
  }

  const creditVault = async (amount: bigint) => {
    await setSplToAccount(
      context,
      mintKeypair.publicKey,
      addresses.tokenVault,
      addresses.tokenVault,
      amount
    );
  };

  const creditSpl = async (amount: bigint, address: PublicKey) => {
    await createTokenAccountAndCredit(
      context,
      mintKeypair.publicKey,
      address,
      amount
    );
  };

  const creditNft = async (address: PublicKey) => {
    await createTokenAccountAndCredit(context, addresses.nft, address, 1n);
  };

  beforeEach(async () => {
    seedAccounts = await getSeedAccounts();
  });

  beforeEach(async () => {
    context = await startAnchor("", [], seedAccounts);
    provider = new BankrunProvider(context);
    program = new Program<ViridisStaking>(IDL as ViridisStaking, provider);
    addresses = await setupAddresses(
      program.programId,
      context,
      userA.publicKey,
      mintKeypair.publicKey
    );
    await setupEnvironment(context, program);
  });

  it("should successfully update config parameters", async () => {
    const updateArgs = {
      admin: userB.publicKey,
      baseLockDays: 0,
      maxNftApyDurationDays: 92,
      baseApy: 500,
      maxNftRewardLamports: new BN(1_000_000),
      nftDaysApy: [
        { days: 30, apy: 1000 },
        { days: 60, apy: 2000 },
        { days: 90, apy: 3000 },
      ],
    };

    // Update config
    await program.methods
      .updateConfig(updateArgs)
      .accounts({
        config: addresses.config,
        admin: userA.publicKey,
      })
      .signers([userA])
      .rpc();

    // Fetch updated config
    const updatedConfig = await fetchConfig();

    assertDeepEqual<Omit<typeof updatedConfig, "nftCollection">>(
      updatedConfig,
      updateArgs
    );
  });

  it("should initialize stake info that holds owner information", async () => {
    await initializeStakeInfoRpc(userA, program);

    // Fetch the initial stake
    const stakeInfo = await fetchStakeInfo(
      addresses.getStakeInfo(userA.publicKey)
    );

    expect(stakeInfo.address.toBase58()).to.equal(userA.publicKey.toBase58());
  });

  it("should create stakes with different configurations before and after config update", async () => {
    // Initial setup
    await initializeStakeInfoRpc(userA, program);
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    // Fetch initial config
    const initialConfig = await fetchConfig();

    // Create a stake with the initial configuration
    const initialStakeAmount = d(100_000);
    await stakeRpc(initialStakeAmount, userA, mintKeypair.publicKey, program);
    await lockNftRpc(
      0,
      initialConfig.nftDaysApy[0].days,
      userA,
      addresses.nft,
      program
    );

    // Fetch the initial stake
    const [initialStake] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    // Assert initial stake parameters
    expect(initialStake.stakeLockDays).to.equal(initialConfig.baseLockDays);
    expect(initialStake.baseApy).to.equal(initialConfig.baseApy);
    expect(initialStake.nftLockDays).to.equal(initialConfig.nftDaysApy[0].days);
    expect(initialStake.nftApy).to.equal(initialConfig.nftDaysApy[0].apy);
    expect(
      initialStake.maxNftRewardLamports.eq(
        new BN(initialConfig.maxNftRewardLamports)
      )
    ).to.be.true;
    expect(initialStake.maxNftApyDurationDays).to.equal(
      initialConfig.maxNftApyDurationDays
    );

    // Prepare update arguments
    const updateArgs = {
      admin: null,
      baseLockDays: 0, // New base lock days
      maxNftApyDurationDays: 100, // New max NFT APY duration
      baseApy: 350, // New base APY (5%)
      maxNftRewardLamports: new BN(1_000_000), // New max NFT reward
      nftDaysApy: [
        { days: 10, apy: 1000 }, // 10%
        { days: 13, apy: 2000 }, // 20%
        { days: 95, apy: 3000 }, // 30%
      ],
    };

    // Update config
    await program.methods
      .updateConfig(updateArgs)
      .accounts({
        admin: userA.publicKey,
      })
      .signers([userA])
      .rpc();

    // Fetch updated config
    const updatedConfig = await fetchConfig();

    // Create a new stake with the updated configuration
    const newStakeAmount = d(200_000);
    await stakeRpc(newStakeAmount, userA, mintKeypair.publicKey, program);

    await creditNft(userA.publicKey);

    await lockNftRpc(
      1,
      updatedConfig.nftDaysApy[0].days,
      userA,
      addresses.nft,
      program
    );

    // Fetch all stakes
    const [_, newStake] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    // Assert new stake parameters
    expect(newStake.stakeLockDays).to.equal(updatedConfig.baseLockDays);
    expect(newStake.baseApy).to.equal(updatedConfig.baseApy);
    expect(newStake.nftLockDays).to.equal(updatedConfig.nftDaysApy[0].days);
    expect(newStake.nftApy).to.equal(updatedConfig.nftDaysApy[0].apy);
    expect(
      newStake.maxNftRewardLamports.eq(
        new BN(updatedConfig.maxNftRewardLamports)
      )
    ).to.be.true;
    expect(newStake.maxNftApyDurationDays).to.equal(
      updatedConfig.maxNftApyDurationDays
    );

    // Verify that the initial stake remains unchanged
    const [unchangedInitialStake] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    expect(unchangedInitialStake).to.deep.equal(initialStake);

    // Create a stake with new NFT lock period (should succeed)
    await stakeRpc(d(50_000), userA, mintKeypair.publicKey, program);

    await creditNft(userA.publicKey);

    // Try to create a stake with old NFT lock period (should fail)
    await expect(
      lockNftRpc(
        2,
        initialConfig.nftDaysApy[0].days,
        userA,
        addresses.nft,
        program
      )
    ).to.be.rejectedWith(/Invalid stake period/);

    await lockNftRpc(
      2,
      updatedConfig.nftDaysApy[1].days,
      userA,
      addresses.nft,
      program
    );

    // Fetch all stakes again
    const [, , newestStake] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    // Assert newest stake parameters
    expect(newestStake.nftLockDays).to.equal(updatedConfig.nftDaysApy[1].days);
    expect(newestStake.nftApy).to.equal(updatedConfig.nftDaysApy[1].apy);

    await stakeRpc(d(50_000), userA, mintKeypair.publicKey, program);
    await destakeRpc(3, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 10, context);
    await destakeRpc(1, userA, mintKeypair.publicKey, program);
  });

  it("should correctly handle staking 1M tokens, NFT locking for 90 days, claiming after 1 year, destaking after 366 days, and NFT unlocking", async () => {
    const {
      baseApy,
      baseLockDays,
      maxNftRewardLamports,
      maxNftApyDurationDays,
    } = await fetchConfig();

    const userTokens = d(1_000_000);
    const vaultTokens = d(5_000_000_000);

    await creditSpl(userTokens, userA.publicKey);
    await creditNft(userA.publicKey);
    await creditVault(vaultTokens);

    const nftLockPeriod = 90;
    const nftAPY = DEFAULT_NFT_APY[nftLockPeriod];

    const instructions: TransactionInstruction[] = [
      await getInitializeStakeInfoInstruction(),
      await getStakeTokenInstruction(userTokens),
      await getLockNftInstruction(0, nftLockPeriod),
    ];

    const messageV0 = new TransactionMessage({
      payerKey: userA.publicKey,
      recentBlockhash: context.lastBlockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([userA]);

    const clockBeforeStaking = await context.banksClient.getClock();

    await context.banksClient.processTransaction(tx);

    const [stake] = await fetchStakes(addresses.getStakeInfo(userA.publicKey));

    const userBalanceAfterStaking = await getBalance(addresses.userToken);
    const userStakeBalance = await getBalance(addresses.userStake);

    expect(
      eq(userBalanceAfterStaking, 0),
      "updated user balance after staking should equal 0"
    ).true;

    expect(
      eq(userStakeBalance, userTokens),
      "user stake account should equal initial user balance"
    ).true;

    expect(
      eq(stake.amount, userTokens),
      "stake account should hold initial user balance"
    ).true;

    const expectedStakeAfterStaking: StakeEntry = {
      amount: new BN(userTokens),
      startTime: new BN(clockBeforeStaking.unixTimestamp),
      stakeLockDays: baseLockDays,
      baseApy,
      nft: addresses.nft,
      nftLockTime: stake.startTime,
      nftLockDays: nftLockPeriod,
      nftApy: nftAPY,
      nftUnlockTime: null,
      destakeTime: null,
      restakeTime: null,
      parentStakeIndex: null,
      paidAmount: new BN(0),
      maxNftApyDurationDays: maxNftApyDurationDays,
      maxNftRewardLamports: maxNftRewardLamports,
    };

    assertDeepEqual(stake, expectedStakeAfterStaking);

    await simulateTimePassage(ONE_YEAR_SECONDS, context);

    const expectedAnnualReward = calculateClaimableReward(stake, 365, nftAPY);

    await claimRpc(0, userA, mintKeypair.publicKey, program);

    const userBalanceAfterClaim = await getBalance(addresses.userToken);

    expect(
      eq(expectedAnnualReward, userBalanceAfterClaim),
      "user balance should have annual reward"
    ).true;

    const [stakeAfterClaim] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    const expectedStakeAfterClaim: StakeEntry = {
      ...expectedStakeAfterStaking,
      paidAmount: new BN(expectedAnnualReward.toString()),
    };

    assertDeepEqual(stakeAfterClaim, expectedStakeAfterClaim);

    await simulateTimePassage(ONE_DAY_SECONDS, context);

    const clockBeforeDestake = await context.banksClient.getClock();

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    const expectedRewardAfterDestake = calculateClaimableReward(
      stake,
      366,
      nftAPY
    );

    const userBalanceAfterDestake = await getBalance(addresses.userToken);

    expect(
      closeTo(
        userBalanceAfterDestake,
        userTokens + BigInt(expectedRewardAfterDestake)
      ),
      "user balance after destake should equal their initial balance and (365 + 1) days reward"
    ).true;

    const vaultBalanceAfterDestake = await getBalance(addresses.tokenVault);

    expect(
      closeTo(
        vaultBalanceAfterDestake,
        vaultTokens - BigInt(expectedRewardAfterDestake)
      ),
      "Vault after destake does not match"
    ).true;

    const [stakeAfterDestake] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    expect(
      eq(stakeAfterDestake.destakeTime, clockBeforeDestake.unixTimestamp),
      "stake should have destaked status"
    ).true;

    const clockAfterDestake = await context.banksClient.getClock();

    await program.methods
      .unlockNft(new BN(0))
      .accounts({
        signer: userA.publicKey,
        mint: addresses.nft,
      })
      .signers([userA])
      .rpc();

    const [stakeAfterNftUnlock] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const nftInfo = await fetchNftInfo();

    expect(
      eq(nftInfo.daysLocked, 366),
      "nft info should have right amount of locked days"
    ).true;

    expect(
      eq(stakeAfterNftUnlock.nftUnlockTime, clockAfterDestake.unixTimestamp),
      "stake unlock time should equal current block timestamp"
    ).true;

    expect(
      closeTo(stakeAfterNftUnlock.paidAmount, expectedRewardAfterDestake),
      "stake paid amount should equal (365 + 1) days reward"
    ).true;
  });

  it("should successfully initialize stake info for a new user", async () => {
    await initializeStakeInfoRpc(userA, program);
    const stakes = await fetchStakes(addresses.getStakeInfo(userA.publicKey));
    expect(stakes).to.be.an("array").that.is.empty;
  });

  it("should fail on double initialization", async () => {
    const instructions: TransactionInstruction[] = [
      await getInitializeStakeInfoInstruction(),
    ];

    const messageV0 = new TransactionMessage({
      payerKey: userA.publicKey,
      recentBlockhash: context.lastBlockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([userA]);

    await context.banksClient.processTransaction(tx);

    await expectErrorWitLog(
      initializeStakeInfoRpc(userA, program),
      "custom program error: 0x0"
    );
  });

  it("should initialize for multiple users", async () => {
    await initializeStakeInfoRpc(userA, program);
    await initializeStakeInfoRpc(userB, program);
  });

  it("should fail when locking NFT with invalid lock period", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(1_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      lockNftRpc(0, 15, userA, addresses.nft, program),
      "Invalid stake period"
    );
  });

  it("should fail when locking locked NFT second time", async () => {
    let [stakeAmount1, stakeAmount2] = [d(50_000), d(30_000)];

    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(stakeAmount1, userA, mintKeypair.publicKey, program);
    await stakeRpc(stakeAmount2, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 30, userA, addresses.nft, program);

    await expectErrorWitLog(
      lockNftRpc(1, 30, userA, addresses.nft, program),
      "Error: insufficient funds"
    );
  });

  it("should fail when locking NFT on a non-existent stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      lockNftRpc(1, 30, userA, addresses.nft, program),
      "Invalid stake index"
    );
  });

  it("should fail when locking NFT of a different collection", async () => {
    it;
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await createTokenAccountAndCredit(
      context,
      TEST_NFT_ADDRESS_WRONG_COLLECTION,
      userA.publicKey,
      1n
    );

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      lockNftRpc(0, 30, userA, TEST_NFT_ADDRESS_WRONG_COLLECTION, program),
      "Invalid NFT collection"
    );
  });

  it("should fail to unlock NFT before stake is destaked", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 30, userA, addresses.nft, program);

    await expectErrorWitLog(
      unlockNftRpc(0, userA, addresses.nft, program),
      "Stake has not been destaked yet"
    );
  });

  it("should fail to unlock NFT on a stake without locked NFT", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 30, userA, addresses.nft, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      unlockNftRpc(1, userA, addresses.nft, program),
      "Invalid NFT mint"
    );
  });

  it("should fail to claim rewards on a non-existent stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);

    await initializeStakeInfoRpc(userA, program);

    await expectErrorWitLog(
      claimRpc(0, userA, mintKeypair.publicKey, program),
      "Invalid stake index"
    );
  });

  it("should fail when claiming destaked stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 14, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      claimRpc(0, userA, mintKeypair.publicKey, program),
      "Stake has already been destaked"
    );
  });

  it("should fail to destake before base lock period", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 13, context);

    await expectErrorWitLog(
      destakeRpc(0, userA, mintKeypair.publicKey, program),
      "Base lock period has not ended"
    );
  });

  it("should fail to destake before nft lock period", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 90, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 89, context);

    await expectErrorWitLog(
      destakeRpc(0, userA, mintKeypair.publicKey, program),
      "NFT lock period has not ended"
    );
  });

  it("should fail to destake a non-existent stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 14, context);

    await expectErrorWitLog(
      destakeRpc(-1, userA, mintKeypair.publicKey, program),
      "Invalid stake index"
    );
  });

  it("should fail to restake a destaked stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 14, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      restakeRpc(0, userA, mintKeypair.publicKey, program),
      "Stake has already been destaked"
    );
  });

  it("should fail to restake a restaked stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 90, userA, addresses.nft, program);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      restakeRpc(1, userA, mintKeypair.publicKey, program),
      "Already restaked"
    );
  });

  it("should fail to restake a non-existent stake", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      restakeRpc(1, userA, mintKeypair.publicKey, program),
      "Invalid stake index"
    );
  });

  it("should fail to restake without locked nft", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      restakeRpc(0, userA, mintKeypair.publicKey, program),
      "No NFT is locked in this stake"
    );
  });

  it("should restake just before 1/3 when lock period is 30 days", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 30, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 10, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);
  });

  it("should restake just before 1/3 when lock period is 60 days", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 60, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 20, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);
  });

  it("should restake just before 1/3 when lock period is 90 days", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 90, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 30, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);
  });

  it("should fail to destake restaked stake before nft lock period", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 90, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 30, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 14, context);

    await expectErrorWitLog(
      destakeRpc(1, userA, mintKeypair.publicKey, program),
      "NFT lock period has not ended"
    );
  });

  it("should fail to destake restaked stake before nft lock period", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, 90, userA, addresses.nft, program);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 119, context);

    await expectErrorWitLog(
      destakeRpc(1, userA, mintKeypair.publicKey, program),
      "NFT lock period has not ended"
    );
  });

  it("should track days NFT has been locked for and successfully reuse previously locked NFT", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);
    const daysToLock = 30;
    const extraDaysOverLockingPeriod = 1;

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(
      ONE_DAY_SECONDS * (daysToLock + extraDaysOverLockingPeriod),
      context
    );

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 5, context);

    await unlockNftRpc(0, userA, addresses.nft, program);

    const nftInfo = await fetchNftInfo();

    expect(
      nftInfo.daysLocked,
      "NFT lock days should equal days before destake"
    ).to.eq(daysToLock + extraDaysOverLockingPeriod);

    const daysToLock2ndTime = 30;

    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(1, daysToLock2ndTime, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysToLock2ndTime, context);

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 5, context);

    await unlockNftRpc(1, userA, addresses.nft, program);

    const nftInfoAfter2ndStake = await fetchNftInfo();

    expect(
      nftInfoAfter2ndStake.daysLocked,
      "NFT lock days should equal days before destake"
    ).to.eq(daysToLock + daysToLock2ndTime + extraDaysOverLockingPeriod);
  });

  it("should fail if NFT max staking period ended", async () => {
    await creditSpl(d(1_000_000), userA.publicKey);
    await creditVault(d(1_000_000));
    await creditNft(userA.publicKey);
    const daysToLock = 60;
    const extraDaysOverLockingPeriod = 1;

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(
      ONE_DAY_SECONDS * (daysToLock + extraDaysOverLockingPeriod),
      context
    );

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    await unlockNftRpc(0, userA, addresses.nft, program);

    const daysToLock2ndTime = 30;

    await stakeRpc(d(10_000), userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      lockNftRpc(1, daysToLock2ndTime, userA, addresses.nft, program),
      "Exceeds maximum lock duration"
    );
  });

  it("should correctly reward user with NFT-boosted APY after 90-day locked staking period of 1,000,000 tokens", async () => {
    const daysToLock = 90;
    const userCoins = d(1_000_000);

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(5_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysToLock, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake] = await fetchStakes(addresses.getStakeInfo(userA.publicKey));

    const expectedReward = calculateClaimableReward(stake, daysToLock, nftAPY);

    expect(eq(userBalance, userCoins + BigInt(expectedReward))).true;
    expect(eq(userBalance, 1_271_232_876712328n)).true;
  });

  it("should correctly reward user with NFT-boosted APY after 90-day locked staking period of 5,000,000 tokens and NFT reward limited to 750,000", async () => {
    const daysToLock = 90;
    const userCoins = d(5_000_000);

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysToLock, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake] = await fetchStakes(addresses.getStakeInfo(userA.publicKey));

    const expectedReward = calculateClaimableReward(stake, daysToLock, nftAPY);

    expect(eq(userBalance, userCoins + BigInt(expectedReward))).true;
    expect(eq(userBalance, 5_817808_219178082n)).true; //67k from base 750k from nft
  });

  it("should correctly reward user with NFT-boosted APY for a 90-day locked staking period, including a restake after 30 days (1/3 of lock period), with initial stake of 500,000 tokens", async () => {
    const daysToLock = 90;
    const daysBeforeRestake = 30;
    const userCoins = d(500_000);

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 90, context);

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake1, stake2]: StakeEntry[] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const expectedStake1Reward = calculateClaimableReward(
      stake1,
      daysBeforeRestake,
      nftAPY
    );

    const expectedStake2Reward = calculateClaimableReward(
      stake2,
      daysToLock,
      nftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(expectedStake1Reward + expectedStake2Reward)
      )
    ).true;

    expect(eq(userBalance, 680821_917808218n)).true;
  });

  it("should correctly reward user with NFT-boosted APY for a 90-day locked staking period, including a restake after 1 day, with initial stake of 500,000 tokens", async () => {
    const daysToLock = 90;
    const userCoins = d(500_000);
    const minRestakeDays = daysToLock / 3;
    const daysBeforeRestake = 1;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(
      ONE_DAY_SECONDS * (minRestakeDays - daysBeforeRestake + daysToLock),
      context
    );

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake1, stake2]: StakeEntry[] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const expectedStake1Reward = calculateClaimableReward(
      stake1,
      minRestakeDays,
      nftAPY
    );

    const expectedStake2Reward = calculateClaimableReward(
      stake2,
      daysToLock,
      nftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(expectedStake1Reward + expectedStake2Reward)
      )
    ).true;

    expect(eq(userBalance, 680821_917808218n)).true;
  });

  it("should correctly reward user with NFT-boosted APY for a 30-day locked staking period, including a restake after 8 day, with initial stake of 500,000 tokens", async () => {
    const daysToLock = 30;
    const userCoins = d(500_000);
    const minRestakeDays = daysToLock / 3;
    const daysBeforeRestake = 8;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(
      ONE_DAY_SECONDS * (minRestakeDays - daysBeforeRestake + daysToLock),
      context
    );

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake1, stake2]: StakeEntry[] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const expectedStake1Reward = calculateClaimableReward(
      stake1,
      minRestakeDays,
      nftAPY
    );

    const expectedStake2Reward = calculateClaimableReward(
      stake2,
      daysToLock,
      nftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(expectedStake1Reward + expectedStake2Reward),
        3
      )
    ).true;

    expect(eq(userBalance, 519178_082191778n)).true;
  });

  it("should correctly reward user with NFT-boosted APY for a 30-day locked staking period, including a restake after 15 day, with initial stake of 500,000 tokens", async () => {
    const daysToLock = 60;
    const userCoins = d(500_000);
    const minRestakeDays = daysToLock / 3;
    const daysBeforeRestake = 15;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(
      ONE_DAY_SECONDS * (minRestakeDays - daysBeforeRestake + daysToLock),
      context
    );

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake1, stake2]: StakeEntry[] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const expectedStake1Reward = calculateClaimableReward(
      stake1,
      minRestakeDays,
      nftAPY
    );

    const expectedStake2Reward = calculateClaimableReward(
      stake2,
      daysToLock,
      nftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(expectedStake1Reward + expectedStake2Reward),
        3
      )
    ).true;

    expect(eq(userBalance, 571232_876712327n)).true;
  });

  it("should correctly reward user with NFT-boosted APY for two consecutive staking periods (30 and 60 days) with initial stake of 500,000 tokens, including NFT locking and unlocking", async () => {
    const userCoins = d(500_000);
    const stake1days = 30;
    const stake2days = 60;
    const stake1NftAPY = DEFAULT_NFT_APY[stake1days];
    const stake2NftAPY = DEFAULT_NFT_APY[stake2days];

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, stake1days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stake1days, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(0, userA, addresses.nft, program);

    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(1, stake2days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stake2days, context);

    await destakeRpc(1, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(1, userA, addresses.nft, program);

    const nftInfo = await fetchNftInfo();

    expect(nftInfo.daysLocked, "nft info should hold correct lock value").to.eq(
      stake1days + stake2days
    );

    const userBalance = await getBalance(addresses.userToken);

    const [stake1, stake2] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    const stake1Reward = calculateClaimableReward(
      stake1,
      stake1days,
      stake1NftAPY
    );

    const stake2Reward = calculateClaimableReward(
      stake2,
      stake2days,
      stake2NftAPY
    );

    expect(
      closeTo(userBalance, userCoins + BigInt(stake1Reward + stake2Reward), 2)
    ).true;
    expect(eq(userBalance, 567808_219178080n)).true;
  });

  it("should correctly reward user with NFT-boosted APY for a 30-day staking period and then prevent locking NFT for 90 days due to maximum lock duration", async () => {
    const userCoins = d(500_000);
    const stake1days = 30;
    const stake2days = 90;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, stake1days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stake1days, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(0, userA, addresses.nft, program);

    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);

    await expectErrorWitLog(
      lockNftRpc(1, stake2days, userA, addresses.nft, program),
      "Exceeds maximum lock duration"
    );
  });

  it("should correctly reward user with NFT-boosted APY for three staking periods (30, 30(restake), and 60 days) with initial stake of 500,000 tokens, including NFT locking, unlocking, and restaking", async () => {
    const userCoins = d(500_000);
    const stake1days = 30;
    const stake2days = 60;
    const daysBeforeRestake = stake2days / 3;
    const stake1NftAPY = DEFAULT_NFT_APY[stake1days];
    const stake2NftAPY = DEFAULT_NFT_APY[stake2days];

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, stake1days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stake1days, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(0, userA, addresses.nft, program);

    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(1, stake2days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(1, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stake2days, context);

    await destakeRpc(2, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(2, userA, addresses.nft, program);

    const nftInfo = await fetchNftInfo();

    expect(nftInfo.daysLocked, "nft info should hold correct lock value").to.eq(
      stake1days + stake2days
    );

    const userBalance = await getBalance(addresses.userToken);

    const [stake1, stake2, stake3] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );

    const stake1Reward = calculateClaimableReward(
      stake1,
      stake1days,
      stake1NftAPY
    );

    const stake2Reward = calculateClaimableReward(
      stake2,
      daysBeforeRestake,
      stake2NftAPY
    );

    const stake3Reward = calculateClaimableReward(
      stake3,
      stake2days,
      stake2NftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(stake1Reward + stake2Reward + stake3Reward),
        5
      )
    ).true;
  });

  it("should correctly prevent destaking due to base and nft lock periods", async () => {
    const userCoins = d(500_000);
    const stake1days = 30;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, stake1days, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * 13, context);

    await expectErrorWitLog(
      destakeRpc(0, userA, mintKeypair.publicKey, program),
      "Base lock period has not ended"
    );

    await simulateTimePassage(ONE_DAY_SECONDS, context);

    const instructions: TransactionInstruction[] = [
      await getDestakeTokenInstruction(0),
    ];

    const messageV0 = new TransactionMessage({
      payerKey: userA.publicKey,
      recentBlockhash: context.lastBlockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(messageV0);
    tx.sign([userA]);

    const result = await context.banksClient.simulateTransaction(tx);

    expect(
      result.meta?.logMessages.some((log) =>
        log.includes("NFT lock period has not ended")
      )
    ).true;
  });

  it("should successfully lock nft 2 times by different users", async () => {
    const userACoins = d(500_000);
    const userBCoins = d(100_000);
    const stakeAdays = 30;
    const stakeBdays = 60;

    await creditSpl(userACoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userACoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, stakeAdays, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stakeAdays, context);

    await destakeRpc(0, userA, mintKeypair.publicKey, program);
    await unlockNftRpc(0, userA, addresses.nft, program);

    await creditSpl(userBCoins, userB.publicKey);
    await creditNft(userB.publicKey);
    await initializeStakeInfoRpc(userB, program);
    await stakeRpc(userBCoins, userB, mintKeypair.publicKey, program);
    await lockNftRpc(0, stakeBdays, userB, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * stakeBdays, context);

    await destakeRpc(0, userB, mintKeypair.publicKey, program);
    await unlockNftRpc(0, userB, addresses.nft, program);

    const nftInfo = await fetchNftInfo();

    expect(nftInfo.daysLocked).to.eq(stakeAdays + stakeBdays);
  });

  it("should correctly reward user with NFT-boosted APY for a 90-day locked staking period, including a restake after 110 day, with initial stake of 500,000 tokens", async () => {
    const daysToLock = 90;
    const userCoins = d(500_000);
    const daysBeforeRestake = 110;

    await creditSpl(userCoins, userA.publicKey);
    await creditVault(d(10_000_000));
    await creditNft(userA.publicKey);

    await initializeStakeInfoRpc(userA, program);
    await stakeRpc(userCoins, userA, mintKeypair.publicKey, program);
    await lockNftRpc(0, daysToLock, userA, addresses.nft, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysBeforeRestake, context);

    await restakeRpc(0, userA, mintKeypair.publicKey, program);

    await simulateTimePassage(ONE_DAY_SECONDS * daysToLock, context);

    await destakeRpc(1, userA, mintKeypair.publicKey, program);

    const userBalance = await getBalance(addresses.userToken);

    const nftAPY = DEFAULT_NFT_APY[daysToLock];
    const [stake1, stake2]: StakeEntry[] = await fetchStakes(
      addresses.getStakeInfo(userA.publicKey)
    );
    const expectedStake1Reward = calculateClaimableReward(
      stake1,
      daysBeforeRestake,
      nftAPY
    );

    const expectedStake2Reward = calculateClaimableReward(
      stake2,
      daysToLock,
      nftAPY
    );

    expect(
      closeTo(
        userBalance,
        userCoins + BigInt(expectedStake1Reward + expectedStake2Reward),
        3
      )
    ).true;
  });
});
