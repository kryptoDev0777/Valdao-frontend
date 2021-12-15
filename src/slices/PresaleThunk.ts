import { ethers, BigNumber } from "ethers";
import { addresses } from "../constants";
import { abi as ierc20Abi } from "../abi/IERC20.json";
import { abi as ValdaoStaking } from "../abi/ValdaoStaking.json";
import { abi as StakingHelper } from "../abi/StakingHelper.json";
import { abi as Presale } from "../abi/Presale.json";
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

function alreadyApprovedToken(token: string, presaleAllowance: BigNumber) {
  // set defaults
  let bigZero = BigNumber.from("0");
  let applicableAllowance = bigZero;

  // determine which allowance to check
  if (token === "mim") {
    applicableAllowance = presaleAllowance;
  }

  // check if allowance exists
  if (applicableAllowance.gt(bigZero)) return true;

  return false;
}

export const changeApproval = createAsyncThunk(
  "presale/changeApproval",
  async ({ token, provider, address, networkID }: IChangeApprovalAsyncThunk, { dispatch }) => {
    if (!provider) {
      dispatch(error("Please connect your wallet!"));
      return;
    }

    const signer = provider.getSigner();
    const busdContract = new ethers.Contract(addresses[networkID].MIM_ADDRESS as string, ierc20Abi, signer);
    let approveTx;
    let presaleAllowance = await busdContract.allowance(address, addresses[networkID].PRESALE_ADDRESS);

    // return early if approval has already happened
    if (alreadyApprovedToken(token, presaleAllowance)) {
      dispatch(info("Approval completed."));
      return dispatch(
        fetchAccountSuccess({
          presale: {
            presaleAllowance: +presaleAllowance,
          },
        }),
      );
    }

    try {
      if (token === "mim") {
        // won't run if stakeAllowance > 0
        approveTx = await busdContract.approve(
          addresses[networkID].PRESALE_ADDRESS,
          ethers.utils.parseUnits("1000000000000000000", "gwei").toString(),
        );
      }

      const text = "Approve MIM";
      const pendingTxnType = "approve_deposit";
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
    presaleAllowance = await busdContract.allowance(address, addresses[networkID].PRESALE_ADDRESS);

    return dispatch(
      fetchAccountSuccess({
        presale: {
          presaleAllowance: +presaleAllowance,
        },
      }),
    );
  },
);



export const changeDeposit = createAsyncThunk(
  "presale/changeDeposit",
  async ({ action, value, provider, address, networkID }: IActionValueAsyncThunk, { dispatch }) => {
    if (!provider) {
      dispatch(error("Please connect your wallet!"));
      return;
    }

    const signer = provider.getSigner();
    const presale = new ethers.Contract(addresses[networkID].PRESALE_ADDRESS as string, Presale, signer);
    console.log('debug->PresaleThunk.ts')

    let depositTx;
    let uaData: IUAData = {
      address: address,
      value: value,
      approved: true,
      txHash: null,
      type: null,
    };
    try {
      uaData.type = "presale";
      console.log("depositing......");
      console.log(ethers.utils.parseUnits(value, "ether"));
      console.log(address);
      console.log(presale);
      depositTx = await presale.deposit(ethers.utils.parseUnits(value, "ether"));
      const pendingTxnType = "depositing";
      uaData.txHash = depositTx.hash;
      dispatch(fetchPendingTxns({ txnHash: depositTx.hash, text: "Depositing...", type: pendingTxnType }));
      await depositTx.wait();
    } catch (e: unknown) {
      uaData.approved = false;
      const rpcError = e as IJsonRPCError;
      if (rpcError.code === -32603 && rpcError.message.indexOf("ds-math-sub-underflow") >= 0) {
        dispatch(
          error(
            "You may be trying to deposit more than your balance! Error code: 32603. Message: ds-math-sub-underflow",
          ),
        );
      } else {
        dispatch(error(rpcError.message));
      }
      return;
    } finally {
      if (depositTx) {
        // segmentUA(uaData);

        dispatch(clearPendingTxn(depositTx.hash));
      }
    }
    dispatch(getBalances({ address, networkID, provider }));
  },
);
