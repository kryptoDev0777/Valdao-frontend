import { ethers, BigNumber } from "ethers";
import { addresses } from "../constants";
import { abi as ierc20Abi } from "../abi/IERC20.json";
import { abi as ValdaoStaking } from "../abi/ValdaoStaking.json";
import { abi as StakingHelper } from "../abi/StakingHelper.json";
import { abi as Presale } from "../abi/Presale.json";
import { abi as pBHD } from "../abi/pBHD.json";
import { clearPendingTxn, fetchPendingTxns, getStakingTypeText } from "./PendingTxnsSlice";
import { createAsyncThunk } from "@reduxjs/toolkit";
import { fetchAccountSuccess, getBalances } from "./AccountSlice";
import { error, info } from "../slices/MessagesSlice";
import { IActionValueAsyncThunk, IChangeApprovalAsyncThunk, IJsonRPCError } from "./interfaces";
import { segmentUA } from "../helpers/userAnalyticHelpers";

interface IUAData {
  address: string;
  value: string;
  approved: boolean;
  txHash: string | null;
  type: string | null;
}

function alreadyApprovedToken(token: string, claimAllowance: BigNumber) {
  // set defaults
  let bigZero = BigNumber.from("0");
  let applicableAllowance = bigZero;

  // determine which allowance to check
  if (token === "pbhd") {
    applicableAllowance = claimAllowance;
  }

  // check if allowance exists
  if (applicableAllowance.gt(bigZero)) return true;

  return false;
}

export const changeApproval = createAsyncThunk(
  "claim/changeApproval",
  async ({ token, provider, address, networkID }: IChangeApprovalAsyncThunk, { dispatch }) => {
    if (!provider) {
      dispatch(error("Please connect your wallet!"));
      return;
    }

    const signer = provider.getSigner();
    const pbhdContract = new ethers.Contract(addresses[networkID].AVALDAO_ADDRESS as string, pBHD, signer);
    let approveTx;
    let claimAllowance = await pbhdContract.allowance(address, addresses[networkID].PRESALE_ADDRESS);

    // return early if approval has already happened
    if (alreadyApprovedToken(token, claimAllowance)) {
      dispatch(info("Approval completed."));
      return dispatch(
        fetchAccountSuccess({
          claim: {
            claimAllowance: +claimAllowance,
          },
        }),
      );
    }

    try {
      if (token === "pbhd") {
        // won't run if stakeAllowance > 0
        approveTx = await pbhdContract.approve(
          addresses[networkID].PRESALE_ADDRESS,
          ethers.utils.parseUnits("1000000000", "gwei").toString(),
        );
      }

      const text = "Approve pBHD";
      const pendingTxnType = "approve_claim";
      dispatch(fetchPendingTxns({ txnHash: approveTx.hash, text, type: pendingTxnType }));

      await approveTx.wait();
    } catch (e: unknown) {
      dispatch(error((e as IJsonRPCError).message));
      return;
    } finally {
      if (approveTx) {
        dispatch(clearPendingTxn(approveTx.hash));
      }
    }

    // go get fresh allowances
    claimAllowance = await pbhdContract.allowance(address, addresses[networkID].PRESALE_ADDRESS);

    return dispatch(
      fetchAccountSuccess({
        claim: {
          claimAllowance: +claimAllowance,
        },
      }),
    );
  },
);

export const changeClaim = createAsyncThunk(
  "claim/changeClaim",
  async ({ action, value, provider, address, networkID }: IActionValueAsyncThunk, { dispatch }) => {
    if (!provider) {
      dispatch(error("Please connect your wallet!"));
      return;
    }

    const signer = provider.getSigner();
    const presale = new ethers.Contract(addresses[networkID].PRESALE_ADDRESS as string, Presale, signer);

    let claimTx;
    let uaData: IUAData = {
      address: address,
      value: value,
      approved: true,
      txHash: null,
      type: null,
    };
    try {
      uaData.type = "claim";
      console.log("claiming......");
      console.log(ethers.utils.parseUnits(value, "gwei"));
      console.log(address);
      claimTx = await presale.withdraw(ethers.utils.parseUnits(value, "gwei"));
      const pendingTxnType = "claiming";
      uaData.txHash = claimTx.hash;
      dispatch(fetchPendingTxns({ txnHash: claimTx.hash, text: "Claiming...", type: pendingTxnType }));
      await claimTx.wait();
    } catch (e: unknown) {
      uaData.approved = false;
      const rpcError = e as IJsonRPCError;
      if (rpcError.code === -32603 && rpcError.message.indexOf("ds-math-sub-underflow") >= 0) {
        dispatch(
          error("You may be trying to claim more than your balance! Error code: 32603. Message: ds-math-sub-underflow"),
        );
      } else {
        dispatch(error(rpcError.message));
      }
      return;
    } finally {
      if (claimTx) {
        // segmentUA(uaData);

        dispatch(clearPendingTxn(claimTx.hash));
      }
    }
    dispatch(getBalances({ address, networkID, provider }));
  },
);
