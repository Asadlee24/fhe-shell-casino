// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {FHE, euint32} from "@fhevm/solidity/lib/FHE.sol";
import {MysteryBoxInvite} from "../MysteryBoxInvite.sol";

contract ShellDrawFixture is MysteryBoxInvite {
    uint32 private _draw;

    constructor(address confidential, address clear) MysteryBoxInvite(confidential, clear, false) {}

    function setDraw(uint32 value) external {
        _draw = value;
    }

    function _drawShell() internal override returns (euint32) {
        return FHE.asEuint32(_draw);
    }
}
